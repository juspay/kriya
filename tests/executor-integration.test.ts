import { AutomationEngine } from '@/core/AutomationEngine';
import { createAutomationTaskHost } from '@/agent/browser/AutomationTaskHost';
import { createRedactor } from '@/utils/redact';
import type { ActionCommand, AutomationConfig, AutomationEvent, TaskObservation } from '@/types';
import { counterIds } from './helpers/agent-fixtures';
import {
  installLayoutStubs,
  makeScrollable,
  mountHtml,
  resetDom,
  setViewport,
} from './helpers/domHarness';

const engines: AutomationEngine[] = [];
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const command = (
  type: ActionCommand['type'],
  parameters: Readonly<Record<string, string>>,
  timeout = 300
): ActionCommand => ({ type, parameters, timeout });
const engine = (config: Partial<AutomationConfig> = {}): AutomationEngine => {
  const instance = new AutomationEngine({ screenshotOnError: false, debugMode: false, ...config });
  instance.initialize();
  engines.push(instance);
  return instance;
};
const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error('Fixture element is absent.');
  }
  return found as T;
};
const secretValue = (): string =>
  String.fromCharCode(112, 114, 105, 118, 97, 116, 101, 45, 101, 120, 101, 99, 45, 55, 52, 56);
const renderedText = (value: unknown): string => {
  if (value instanceof HTMLInputElement || value instanceof HTMLTextAreaElement) {
    return `${value.outerHTML} ${value.value}`;
  }
  if (value instanceof Element) {
    return value.outerHTML;
  }
  if (value instanceof Error) {
    return `${value.name} ${value.message}`;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(renderedText).join(' ');
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
};

beforeEach(() => {
  resetDom();
  installLayoutStubs();
});
afterEach(() => {
  for (const instance of engines.splice(0)) {
    instance.dispose();
  }
  jest.restoreAllMocks();
  jest.useRealTimers();
  resetDom();
});

describe('real AutomationEngine -> ActionExecutor -> DOMActions integration', () => {
  test('G1 blank fill clears exactly once and a second clear is an uncommitted no-op', async () => {
    mountHtml('<input id="field" value="before"><input id="neighbor" value="untouched">');
    const target = element<HTMLInputElement>('field');
    const events: string[] = [];
    target.addEventListener('input', () => events.push('input'));
    target.addEventListener('change', () => events.push('change'));
    const instance = engine();
    const onCommit = jest.fn();
    const first = await instance.executeAction(command('fill', { strict: 'true', value: '' }), {
      target,
      onCommit,
    });
    expect(first).toMatchObject({
      success: true,
      effect: 'applied',
      data: { kind: 'fill', empty: true, changed: true, matched: true },
    });
    expect(target.value).toBe('');
    expect(element<HTMLInputElement>('neighbor').value).toBe('untouched');
    expect(events).toEqual(['input', 'change']);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const second = await instance.executeAction(command('fill', { strict: 'true', value: '' }), {
      target,
      onCommit,
    });
    expect(second).toMatchObject({
      success: true,
      effect: 'none',
      data: { changed: false, matched: true },
    });
    expect(events).toHaveLength(2);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
  test('G2 an explicit target forces strict fill even when serialized strict is false', async () => {
    mountHtml('<input id="target"><input id="neighbor" value="untouched">');
    const instance = engine();
    const result = await instance.executeAction(
      command('fill', { strict: 'false', selector: '#neighbor', value: 'Ada' }),
      { target: element('target') }
    );
    expect(result).toMatchObject({ success: true, effect: 'applied' });
    expect(element<HTMLInputElement>('target').value).toBe('Ada');
    expect(element<HTMLInputElement>('neighbor').value).toBe('untouched');
  });
  test('G2 strict fill of a label refuses its nested input instead of filling a neighbor', async () => {
    mountHtml('<label id="label">Name<input id="neighbor" value="untouched"></label>');
    const result = await engine().executeAction(command('fill', { strict: 'true', value: 'Ada' }), {
      target: element('label'),
    });
    expect(result).toMatchObject({ success: false, effect: 'none', errorCode: 'NOT_EDITABLE' });
    expect(element<HTMLInputElement>('neighbor').value).toBe('untouched');
  });
  test('G2 strict click activates exactly the given target once', async () => {
    mountHtml('<button id="target">Continue</button><button id="neighbor">Continue</button>');
    const clicks = jest.fn();
    const neighbor = jest.fn();
    element('target').addEventListener('click', clicks);
    element('neighbor').addEventListener('click', neighbor);
    const onCommit = jest.fn();
    const result = await engine().executeAction(command('click', { strict: 'true' }), {
      target: element('target'),
      onCommit,
    });
    expect(result).toMatchObject({ success: true, effect: 'applied', data: { kind: 'click' } });
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(neighbor).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
  test.each(['fill', 'click', 'press'] as const)(
    'G2 stale %s target never falls back to selector or active neighbor',
    async type => {
      mountHtml('<input id="target"><input id="neighbor" value="untouched">');
      const target = element('target');
      target.remove();
      element('neighbor').focus();
      const observed = jest.fn();
      element('neighbor').addEventListener('click', observed);
      element('neighbor').addEventListener('keydown', observed);
      const parameters: Readonly<Record<string, string>> =
        type === 'fill'
          ? { selector: '#neighbor', strict: 'true', value: 'Ada' }
          : type === 'press'
            ? { selector: '#neighbor', strict: 'true', key: 'Enter', implicitSubmit: 'true' }
            : { selector: '#neighbor', strict: 'true' };
      const result = await engine().executeAction(command(type, parameters), { target });
      expect(result).toMatchObject({ success: false, effect: 'none', errorCode: 'TARGET_STALE' });
      expect(element<HTMLInputElement>('neighbor').value).toBe('untouched');
      expect(observed).not.toHaveBeenCalled();
    }
  );
  test('G2 strict press sends one key sequence to the selected field', async () => {
    mountHtml('<input id="target"><input id="neighbor">');
    const order: string[] = [];
    const neighbor = jest.fn();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      element('target').addEventListener(type, () => order.push(type));
      element('neighbor').addEventListener(type, neighbor);
    }
    const result = await engine().executeAction(
      command('press', { strict: 'true', key: 'Enter', implicitSubmit: 'true' }),
      { target: element('target') }
    );
    expect(result).toMatchObject({
      success: true,
      effect: 'applied',
      data: { kind: 'press', defaultAction: 'none' },
    });
    expect(order).toEqual(['keydown', 'keypress', 'keyup']);
    expect(neighbor).not.toHaveBeenCalled();
  });
  test('G3 native checked state is idempotent and uses one activation', async () => {
    mountHtml('<input id="check" type="checkbox">');
    const clicks = jest.fn();
    const onCommit = jest.fn();
    element('check').addEventListener('click', clicks);
    const instance = engine();
    const action = command('setChecked', { checked: 'true' });
    expect(
      await instance.executeAction(action, { target: element('check'), onCommit })
    ).toMatchObject({
      success: true,
      effect: 'applied',
      data: { kind: 'setChecked', after: true, matched: true },
    });
    expect(
      await instance.executeAction(action, { target: element('check'), onCommit })
    ).toMatchObject({ success: true, effect: 'none', data: { changed: false } });
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
  test('G3 native select changes one option and then reports an uncommitted no-op', async () => {
    mountHtml('<select id="select"><option>First</option><option>Second</option></select>');
    const target = element<HTMLSelectElement>('select');
    const changed = jest.fn();
    target.addEventListener('change', changed);
    const instance = engine();
    const action = command('select', { matchBy: 'index', option: '1' });
    expect(await instance.executeAction(action, { target })).toMatchObject({
      success: true,
      effect: 'applied',
      data: { kind: 'select', index: 1, matched: true },
    });
    expect(await instance.executeAction(action, { target })).toMatchObject({
      success: true,
      effect: 'none',
      data: { changed: false },
    });
    expect(target.selectedIndex).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  test.each([
    ['disabled', '<option disabled>Second</option>', 'OPTION_DISABLED'],
    ['ambiguous', '<option>Second</option><option>Second</option>', 'OPTION_AMBIGUOUS'],
  ] as const)('G3 %s options are rejected before mutation', async (_label, options, code) => {
    mountHtml(`<select id="select"><option>First</option>${options}</select>`);
    const target = element<HTMLSelectElement>('select');
    const result = await engine().executeAction(
      command('select', { matchBy: 'label', option: 'Second' }),
      { target }
    );
    expect(result).toMatchObject({ success: false, effect: 'none', errorCode: code });
    expect(target.selectedIndex).toBe(0);
  });
  test('G3 page and container scrolls report actual movement and edge no-ops', async () => {
    setViewport({ height: 100, scrollHeight: 500 });
    mountHtml('<div id="container" style="overflow-y: auto">Container</div>');
    const container = makeScrollable(element('container'), {
      clientHeight: 100,
      scrollHeight: 400,
    });
    const instance = engine();
    expect(await instance.executeAction(command('scroll', { direction: 'BOTTOM' }))).toMatchObject({
      success: true,
      effect: 'applied',
      data: { moved: true, after: 400 },
    });
    expect(await instance.executeAction(command('scroll', { direction: 'BOTTOM' }))).toMatchObject({
      success: true,
      effect: 'none',
      data: { moved: false, reason: 'edge' },
    });
    expect(
      await instance.executeAction(command('scroll', { direction: 'DOWN' }), { target: container })
    ).toMatchObject({ success: true, effect: 'applied', data: { after: 70 } });
    expect(container.scrollTop).toBe(70);
  });
  test('G4 a pre-aborted signal emits no started event and changes nothing', async () => {
    mountHtml('<input id="field" value="before">');
    const instance = engine();
    const started = jest.fn();
    instance.addEventListener('action_started', started);
    const controller = new AbortController();
    controller.abort();
    const result = await instance.executeAction(
      command('fill', { strict: 'true', value: 'after' }),
      { target: element('field'), signal: controller.signal }
    );
    expect(result).toMatchObject({
      success: false,
      effect: 'none',
      errorCode: 'EXECUTION_CANCELLED',
    });
    expect(element<HTMLInputElement>('field').value).toBe('before');
    expect(started).not.toHaveBeenCalled();
  });
  test.each(['timeout', 'cancel'] as const)(
    'G4 %s during the real legacy click sleep produces no late click',
    async kind => {
      mountHtml('<button id="target">Continue</button>');
      const clicks = jest.fn();
      element('target').addEventListener('click', clicks);
      const controller = new AbortController();
      const pending = engine().executeAction(
        command('click', { selector: '#target' }, kind === 'timeout' ? 5 : 500),
        { signal: controller.signal }
      );
      if (kind === 'cancel') {
        setTimeout(() => controller.abort(), 5);
      }
      const result = await pending;
      expect(result).toMatchObject({
        success: false,
        effect: 'none',
        errorCode: kind === 'timeout' ? 'EXECUTION_TIMEOUT' : 'EXECUTION_CANCELLED',
      });
      await sleep(130);
      expect(clicks).not.toHaveBeenCalled();
    }
  );
  test.each(['timeout', 'cancel'] as const)(
    'G4 %s after a real ARIA activation reports uncertain and never retries',
    async kind => {
      mountHtml(
        '<button id="switch" type="button" role="switch" aria-checked="false">Switch</button>'
      );
      const target = element('switch');
      const controller = new AbortController();
      const clicks = jest.fn();
      target.addEventListener('click', () => {
        clicks();
        if (kind === 'cancel') {
          controller.abort();
        }
      });
      const result = await engine().executeAction(
        command('setChecked', { checked: 'true' }, kind === 'timeout' ? 5 : 500),
        { target, signal: controller.signal }
      );
      expect(result).toMatchObject({
        success: false,
        effect: 'uncertain',
        errorCode: kind === 'timeout' ? 'EXECUTION_TIMEOUT' : 'EXECUTION_CANCELLED',
      });
      await sleep(130);
      expect(clicks).toHaveBeenCalledTimes(1);
      expect(target.getAttribute('aria-checked')).toBe('false');
    }
  );
  test('G6 real browser host rejects foreign and superseded snapshots before calling the real executor', async () => {
    mountHtml('<input id="field" aria-label="Name">');
    const instance = engine();
    const host = createAutomationTaskHost({
      executor: instance,
      createId: counterIds(),
      settle: { quietMs: 0, maxMs: 5 },
    });
    const first = await host.observe({
      sessionId: 'ses_a',
      options: { settle: { quietMs: 0, maxMs: 5 } },
    });
    if (!first.ok) {
      throw new Error('Fixture observation failed.');
    }
    const observation: TaskObservation = first.value;
    const target = observation.elements.find(item => item.operations.includes('FILL'));
    if (!target) {
      throw new Error('Fixture field was not observed.');
    }
    const request = {
      requestId: 'req_a',
      scope: {
        sessionId: observation.sessionId,
        snapshotId: observation.snapshotId,
        documentId: observation.documentId,
      },
      command: {
        operation: 'FILL' as const,
        target: {
          sessionId: observation.sessionId,
          snapshotId: observation.snapshotId,
          targetId: target.id,
          signature: target.signature,
        },
        value: 'Ada',
        sensitive: false,
      },
      allowedOrigins: [window.location.origin],
      timeoutMs: 300,
      settle: { quietMs: 0, maxMs: 5 },
    };
    expect(
      await host.execute({ ...request, scope: { ...request.scope, sessionId: 'ses_b' } })
    ).toMatchObject({ effect: 'none' });
    await host.observe({ sessionId: 'ses_a', options: { settle: { quietMs: 0, maxMs: 5 } } });
    expect(await host.execute(request)).toMatchObject({ status: 'rejected_stale', effect: 'none' });
    expect(element<HTMLInputElement>('field').value).toBe('');
    await host.dispose();
  });
  test.each([
    ['non-string fill', 'fill', { value: 42 }],
    ['unknown key', 'fill', { value: 'Ada', unexpected: 'x' }],
    ['noncanonical boolean', 'setChecked', { checked: 'TRUE' }],
    ['noncanonical index', 'select', { matchBy: 'index', option: '01' }],
    ['object fillForm', 'fillForm', { fields: { name: 'Ada' } }],
    ['nested fillForm JSON', 'fillForm', { fields: '{"name":{"nested":"Ada"}}' }],
  ] as const)(
    'G7 strict %s is rejected without widening the engine payload',
    async (_label, type, parameters) => {
      mountHtml('<input id="field" value="before">');
      const action = { type, parameters } as unknown as ActionCommand;
      const result = await engine().executeAction(action, {
        strict: true,
        target: element('field'),
      });
      expect(result).toMatchObject({
        success: false,
        effect: 'none',
        errorCode: 'VALIDATION_FAILED',
      });
      expect(element<HTMLInputElement>('field').value).toBe('before');
    }
  );
  test('G8 sensitive strict fill has value-free readback and secret-free events and errors', async () => {
    mountHtml('<input id="field" type="password">');
    const secret = secretValue();
    const instance = engine({ debugMode: true, redactor: createRedactor({ secrets: [secret] }) });
    const events: AutomationEvent[] = [];
    const logs: readonly unknown[][] = [];
    const mutableLogs = logs as unknown[][];
    jest.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      mutableLogs.push(args);
    });
    instance.addEventListener('action_started', event => events.push(event));
    instance.addEventListener('action_completed', event => events.push(event));
    instance.addEventListener('action_failed', event => events.push(event));
    const action: ActionCommand = {
      ...command('fill', { strict: 'true', value: secret }),
      sensitiveParameters: ['value'],
    };
    const applied = await instance.executeAction(action, { target: element('field') });
    expect(applied).toMatchObject({ success: true, effect: 'applied', data: { empty: false } });
    expect(Object.prototype.hasOwnProperty.call(applied.data, 'length')).toBe(false);
    const stale = element('field');
    stale.remove();
    const failed = await instance.executeAction(action, { target: stale });
    expect(failed).toMatchObject({ success: false, effect: 'none', errorCode: 'TARGET_STALE' });
    expect(JSON.stringify([events, applied, failed]).includes(secret)).toBe(false);
    expect(renderedText(logs).includes(secret)).toBe(false);
  });
});

// These regression tests use browser DOM seams only. Execution layers remain real.
describe('adversarial executor mutation and redaction boundaries', () => {
  test('G4 abort removes the real navigation load listener before its timeout', async () => {
    await sleep(1);
    const instance = engine();
    const add = jest.spyOn(window, 'addEventListener');
    const remove = jest.spyOn(window, 'removeEventListener');
    const controller = new AbortController();
    const pending = instance.executeAction(
      command(
        'navigate',
        { strict: 'true', url: window.location.href + '#audit-load', waitForLoad: 'true' },
        60
      ),
      { signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 5);
    const result = await pending;
    const listener = add.mock.calls.find(call => call[0] === 'load')?.[1];
    const removedAtReturn =
      listener !== undefined &&
      remove.mock.calls.some(call => call[0] === 'load' && call[1] === listener);
    await sleep(80);
    expect(result).toMatchObject({
      success: false,
      errorCode: 'EXECUTION_CANCELLED',
      effect: 'uncertain',
    });
    window.history.replaceState({}, '', window.location.pathname + window.location.search);
    expect(removedAtReturn).toBe(true);
  });

  test('G8 invalid action type errors are scrubbed with the configured redactor', async () => {
    const secret = secretValue();
    const instance = engine({ redactor: createRedactor({ secrets: [secret] }) });
    const result = await instance.executeAction({
      type: secret,
      parameters: {},
    } as unknown as ActionCommand);
    expect(result).toMatchObject({
      success: false,
      effect: 'none',
      errorCode: 'VALIDATION_FAILED',
    });
    expect(JSON.stringify(result).includes(secret)).toBe(false);
  });
  test('G2 strict fillForm must not fall back to a field in another registered form', async () => {
    mountHtml(
      '<form id="first"><input name="alpha"></form><form id="second"><input id="outside" name="beta" value="untouched"></form>'
    );
    const instance = engine();
    instance.registerForm('first-form', element<HTMLFormElement>('first'));
    const result = await instance.executeAction(
      command('fillForm', { strict: 'true', formId: 'first-form', fields: '{"beta":"Ada"}' })
    );
    expect(element<HTMLInputElement>('outside').value).toBe('untouched');
    expect(result.success).toBe(false);
  });

  test('G4 a cancelled pre-activation click must not scroll the page while claiming effect none', async () => {
    mountHtml('<button id="target">Continue</button>');
    setViewport({ height: 100, scrollHeight: 1000 });
    const target = element('target');
    const controller = new AbortController();
    const clicks = jest.fn();
    target.addEventListener('click', clicks);
    Object.defineProperty(target, 'scrollIntoView', {
      configurable: true,
      value: () => {
        window.scrollTo(0, 200);
        controller.abort();
      },
    });
    const result = await engine().executeAction(command('click', { strict: 'true' }), {
      target,
      signal: controller.signal,
    });
    expect(result).toMatchObject({ success: false, errorCode: 'EXECUTION_CANCELLED' });
    expect(clicks).not.toHaveBeenCalled();
    expect(window.scrollY !== 0 && result.effect === 'none').toBe(false);
  });
  test('G8 legacy debug logs must redact live field references as well as the fill value', async () => {
    mountHtml('<label>Account<input id="field" name="Account" type="password"></label>');
    const secret = secretValue();
    const logs: unknown[][] = [];
    jest.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
    const instance = engine({ debugMode: true, redactor: createRedactor({ secrets: [secret] }) });
    const result = await instance.executeAction({
      ...command('fill', { selector: 'Account', value: secret }),
      sensitiveParameters: ['value'],
    });
    expect(result.success).toBe(true);
    expect(renderedText(logs).includes(secret)).toBe(false);
  });
  test('G4 delayed legacy SelectBox fill must not mutate after the result and engine disposal', async () => {
    mountHtml(
      '<form id="form"><div data-selectbox-value="old"><button id="trigger" name="color" type="button" data-value="old">Color</button><div role="listbox"><div id="option" data-dropdown-value="blue">Blue</div></div></div></form>'
    );
    const instance = engine();
    instance.registerForm('registered', element<HTMLFormElement>('form'));
    const optionClicks = jest.fn();
    element('option').addEventListener('click', optionClicks);
    const result = await instance.executeAction(
      command('fillForm', { strict: 'true', formId: 'registered', fields: '{"color":"blue"}' })
    );
    const clicksAtReturn = optionClicks.mock.calls.length;
    const valueAtReturn = element('trigger').getAttribute('data-value');
    instance.dispose();
    await sleep(180);
    expect(optionClicks).toHaveBeenCalledTimes(clicksAtReturn);
    expect(element('trigger').getAttribute('data-value')).toBe(valueAtReturn);
    expect(result.success ? valueAtReturn === 'blue' : result.effect === 'none').toBe(true);
  });
  test('Enter implicit submit must activate its default submitter click handler once', async () => {
    mountHtml(
      '<form id="form"><input id="field"><button id="submit" type="submit">Submit</button></form>'
    );
    const clicked = jest.fn();
    const submitted = jest.fn();
    element('submit').addEventListener('click', clicked);
    element('form').addEventListener('submit', event => {
      submitted();
      event.preventDefault();
    });
    const result = await engine().executeAction(
      command('press', { strict: 'true', key: 'Enter', implicitSubmit: 'true' }),
      { target: element('field') }
    );
    expect(result.success).toBe(true);
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveBeenCalledTimes(1);
  });
});
