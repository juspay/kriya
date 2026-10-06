import { DOMActions } from '@/actions/DOMActions';
import { createMutationGuard } from '@/actions/guard';
import { setChecked } from '@/actions/strict';
import type { ErrorCode, MutationGuard, SetCheckedOptions } from '@/types';
import { AutomationError, DEFAULT_CONFIG } from '@/types';
import { resetDom } from './helpers/domHarness';

function makeActions(): DOMActions {
  const actions = new DOMActions(DEFAULT_CONFIG);
  actions.initialize();
  return actions;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`fixture is missing #${id}`);
  }
  return element as T;
}

function html(markup: string): void {
  document.body.innerHTML = markup;
}

function options(checked: boolean, overrides: Partial<SetCheckedOptions> = {}): SetCheckedOptions {
  return { checked, ...overrides };
}

async function failureOf(run: Promise<unknown>): Promise<AutomationError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof AutomationError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the action to reject');
}

async function codeOf(run: Promise<unknown>): Promise<ErrorCode> {
  return (await failureOf(run)).code;
}

function tracedGuard(trace: string[], signal?: AbortSignal): MutationGuard {
  const inner = createMutationGuard(signal);
  return {
    get committed(): boolean {
      return inner.committed;
    },
    checkpoint: (): void => inner.checkpoint(),
    commit: (): void => {
      inner.commit();
      trace.push('commit');
    },
  };
}

function recordEvents(types: readonly string[], trace: string[]): void {
  for (const type of types) {
    document.addEventListener(
      type,
      event => trace.push(`${type}@${(event.target as HTMLElement).id}`),
      true
    );
  }
}

function toggleAria(element: HTMLElement, delayMs = 0): void {
  element.addEventListener('click', () => {
    const flip = (): void => {
      element.setAttribute(
        'aria-checked',
        element.getAttribute('aria-checked') === 'true' ? 'false' : 'true'
      );
    };
    if (delayMs === 0) {
      flip();
    } else {
      setTimeout(flip, delayMs);
    }
  });
}

beforeEach(() => {
  resetDom();
});

afterEach(() => {
  jest.restoreAllMocks();
  resetDom();
});

describe('setChecked: native checkbox', () => {
  it('checks an unchecked box with one click, input and change, committed first', async () => {
    html('<input type="checkbox" id="c">');
    const trace: string[] = [];
    recordEvents(['click', 'input', 'change'], trace);
    const outcome = await makeActions().setChecked(options(true), tracedGuard(trace), byId('c'));
    expect(byId<HTMLInputElement>('c').checked).toBe(true);
    expect(trace).toEqual(['commit', 'click@c', 'input@c', 'change@c']);
    expect(outcome).toEqual({
      kind: 'setChecked',
      control: 'native',
      before: false,
      after: true,
      changed: true,
      matched: true,
    });
  });

  it('unchecks a checked box', async () => {
    html('<input type="checkbox" id="c" checked>');
    const outcome = await makeActions().setChecked(options(false), undefined, byId('c'));
    expect(byId<HTMLInputElement>('c').checked).toBe(false);
    expect(outcome).toMatchObject({ before: true, after: false, changed: true, matched: true });
  });

  it.each([
    [true, '<input type="checkbox" id="c" checked>'],
    [false, '<input type="checkbox" id="c">'],
  ])(
    'is idempotent when the box is already %s: no event, no commit, changed:false',
    async (desired, markup) => {
      html(markup);
      const trace: string[] = [];
      recordEvents(['click', 'input', 'change', 'focus'], trace);
      const guard = tracedGuard(trace);
      const outcome = await makeActions().setChecked(options(desired), guard, byId('c'));
      expect(trace).toEqual([]);
      expect(guard.committed).toBe(false);
      expect(outcome).toMatchObject({ kind: 'setChecked', changed: false, matched: true });
    }
  );

  it('commits once and clicks the control exactly once', async () => {
    html('<input type="checkbox" id="c">');
    const trace: string[] = [];
    recordEvents(['click'], trace);
    await makeActions().setChecked(options(true), tracedGuard(trace), byId('c'));
    expect(trace.filter(entry => entry === 'commit')).toHaveLength(1);
    expect(trace.filter(entry => entry.startsWith('click'))).toHaveLength(1);
  });

  it('leaves matched:false and exactly one click when the page calls preventDefault', async () => {
    html('<input type="checkbox" id="c">');
    const clicks: string[] = [];
    byId('c').addEventListener('click', event => {
      clicks.push('click');
      event.preventDefault();
    });
    const guard = createMutationGuard();
    const outcome = await makeActions().setChecked(options(true), guard, byId('c'));
    expect(byId<HTMLInputElement>('c').checked).toBe(false);
    expect(clicks).toEqual(['click']);
    expect(outcome).toEqual({
      kind: 'setChecked',
      control: 'native',
      before: false,
      after: false,
      changed: false,
      matched: false,
    });
    expect(guard.committed).toBe(true);
  });

  it('reports an indeterminate box as mixed and turns it on with one click', async () => {
    html('<input type="checkbox" id="c">');
    byId<HTMLInputElement>('c').indeterminate = true;
    const outcome = await makeActions().setChecked(options(true), undefined, byId('c'));
    expect(outcome).toMatchObject({ before: 'mixed', after: true, matched: true });
  });

  it('refuses to turn a mixed native box off with UNSUPPORTED_STATE', async () => {
    html('<input type="checkbox" id="c">');
    byId<HTMLInputElement>('c').indeterminate = true;
    const guard = createMutationGuard();
    const code = await codeOf(makeActions().setChecked(options(false), guard, byId('c')));
    expect(code).toBe('UNSUPPORTED_STATE');
    expect(guard.committed).toBe(false);
  });

  it('focuses the control it toggles', async () => {
    html('<input type="checkbox" id="c"><input type="checkbox" id="d">');
    await makeActions().setChecked(options(true), undefined, byId('d'));
    expect(document.activeElement).toBe(byId('d'));
  });
});

describe('setChecked: native radio', () => {
  it('checks an unchecked radio and unchecks its group sibling by the browser rule', async () => {
    html('<input type="radio" name="g" id="a" checked><input type="radio" name="g" id="b">');
    const outcome = await makeActions().setChecked(options(true), undefined, byId('b'));
    expect(byId<HTMLInputElement>('b').checked).toBe(true);
    expect(byId<HTMLInputElement>('a').checked).toBe(false);
    expect(outcome).toMatchObject({ control: 'native', before: false, after: true, matched: true });
  });

  it('is a no-op for an already checked radio', async () => {
    html('<input type="radio" name="g" id="a" checked>');
    const trace: string[] = [];
    recordEvents(['click', 'change'], trace);
    const outcome = await makeActions().setChecked(options(true), tracedGuard(trace), byId('a'));
    expect(trace).toEqual([]);
    expect(outcome).toMatchObject({ changed: false, matched: true });
  });

  it.each(['checked', ''])('refuses to uncheck a radio (state: "%s")', async state => {
    html(`<input type="radio" name="g" id="a" ${state}>`);
    const guard = createMutationGuard();
    const code = await codeOf(makeActions().setChecked(options(false), guard, byId('a')));
    expect(code).toBe('UNSUPPORTED_STATE');
    expect(byId<HTMLInputElement>('a').checked).toBe(state === 'checked');
    expect(guard.committed).toBe(false);
  });
});

describe('setChecked: label targets resolve to the control', () => {
  it('resolves label[for] to its checkbox and clicks the input, never the label', async () => {
    html('<input type="checkbox" id="c"><label id="l" for="c">Subscribe</label>');
    const trace: string[] = [];
    recordEvents(['click', 'change'], trace);
    const outcome = await makeActions().setChecked(options(true), tracedGuard(trace), byId('l'));
    expect(byId<HTMLInputElement>('c').checked).toBe(true);
    expect(trace).toEqual(['commit', 'click@c', 'change@c']);
    expect(outcome).toMatchObject({ control: 'native', before: false, after: true });
  });

  it('resolves a label that wraps its input', async () => {
    html('<label id="l"><input type="checkbox" id="c"> Remember me</label>');
    const trace: string[] = [];
    recordEvents(['click'], trace);
    await makeActions().setChecked(options(true), tracedGuard(trace), byId('l'));
    expect(byId<HTMLInputElement>('c').checked).toBe(true);
    expect(trace.filter(entry => entry.startsWith('click'))).toEqual(['click@c']);
  });

  it('is idempotent through the label too', async () => {
    html('<input type="checkbox" id="c" checked><label id="l" for="c">x</label>');
    const trace: string[] = [];
    recordEvents(['click', 'change'], trace);
    const outcome = await makeActions().setChecked(options(true), tracedGuard(trace), byId('l'));
    expect(trace).toEqual([]);
    expect(outcome).toMatchObject({ changed: false, matched: true });
  });

  it('refuses a label that has no control with NOT_CHECKABLE', async () => {
    html('<label id="l">Orphan</label>');
    expect(await codeOf(makeActions().setChecked(options(true), undefined, byId('l')))).toBe(
      'NOT_CHECKABLE'
    );
  });

  it('refuses a label whose control is not a checkbox or radio', async () => {
    html('<label id="l" for="t">Name</label><input id="t" type="text">');
    expect(await codeOf(makeActions().setChecked(options(true), undefined, byId('l')))).toBe(
      'NOT_CHECKABLE'
    );
  });

  it('refuses a label whose control is an ARIA switch: only native controls follow a label', async () => {
    html(
      '<label id="l" for="sw">Dark mode</label><button id="sw" role="switch" aria-checked="false"></button>'
    );
    const clicks: string[] = [];
    byId('sw').addEventListener('click', () => clicks.push('click'));
    expect(await codeOf(makeActions().setChecked(options(true), undefined, byId('l')))).toBe(
      'NOT_CHECKABLE'
    );
    expect(clicks).toEqual([]);
    expect(byId('sw').getAttribute('aria-checked')).toBe('false');
  });

  it('refuses a label whose control is disabled with TARGET_DISABLED', async () => {
    html('<input type="checkbox" id="c" disabled><label id="l" for="c">x</label>');
    const code = await codeOf(makeActions().setChecked(options(true), undefined, byId('l')));
    expect(code).toBe('TARGET_DISABLED');
    expect(byId<HTMLInputElement>('c').checked).toBe(false);
  });
});

describe('setChecked: ARIA controls', () => {
  it('toggles a button role=switch whose handler updates aria-checked synchronously', async () => {
    html('<button id="s" role="switch" aria-checked="false">Notify</button>');
    toggleAria(byId('s'));
    const outcome = await makeActions().setChecked(options(true), undefined, byId('s'));
    expect(byId('s').getAttribute('aria-checked')).toBe('true');
    expect(outcome).toEqual({
      kind: 'setChecked',
      control: 'aria',
      before: false,
      after: true,
      changed: true,
      matched: true,
    });
  });

  it('turns a div role=checkbox off', async () => {
    html('<div id="s" role="checkbox" aria-checked="true" tabindex="0"></div>');
    toggleAria(byId('s'));
    const outcome = await makeActions().setChecked(options(false), undefined, byId('s'));
    expect(outcome).toMatchObject({ control: 'aria', before: true, after: false, matched: true });
  });

  it('settles an ARIA switch whose state updates asynchronously, with a single click', async () => {
    html('<div id="s" role="switch" aria-checked="false"></div>');
    toggleAria(byId('s'), 40);
    const clicks: string[] = [];
    byId('s').addEventListener('click', () => clicks.push('click'));
    const outcome = await makeActions().setChecked(options(true), undefined, byId('s'));
    expect(outcome).toMatchObject({ control: 'aria', after: true, changed: true, matched: true });
    expect(clicks).toEqual(['click']);
  });

  it('reports matched:false and never retries when the control ignores the click', async () => {
    html('<div id="s" role="switch" aria-checked="false"></div>');
    const clicks: string[] = [];
    byId('s').addEventListener('click', () => clicks.push('click'));
    const started = Date.now();
    const outcome = await makeActions().setChecked(options(true), undefined, byId('s'));
    expect(clicks).toEqual(['click']);
    expect(outcome).toMatchObject({ before: false, after: false, changed: false, matched: false });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('is idempotent for an ARIA switch that is already in the requested state', async () => {
    html('<div id="s" role="switch" aria-checked="true"></div>');
    const trace: string[] = [];
    recordEvents(['click'], trace);
    const guard = tracedGuard(trace);
    const outcome = await makeActions().setChecked(options(true), guard, byId('s'));
    expect(trace).toEqual([]);
    expect(guard.committed).toBe(false);
    expect(outcome).toMatchObject({ control: 'aria', changed: false, matched: true });
  });

  it('turns a mixed ARIA checkbox on, and refuses to turn it off', async () => {
    html('<div id="s" role="checkbox" aria-checked="mixed"></div>');
    toggleAria(byId('s'));
    const guard = createMutationGuard();
    expect(await codeOf(makeActions().setChecked(options(false), guard, byId('s')))).toBe(
      'UNSUPPORTED_STATE'
    );
    expect(guard.committed).toBe(false);
    const outcome = await makeActions().setChecked(options(true), undefined, byId('s'));
    expect(outcome).toMatchObject({ before: 'mixed', after: true, matched: true });
  });

  it('refuses to uncheck an ARIA radio', async () => {
    html('<div id="r" role="radio" aria-checked="true"></div>');
    expect(await codeOf(makeActions().setChecked(options(false), undefined, byId('r')))).toBe(
      'UNSUPPORTED_STATE'
    );
  });

  it('rejects aria-disabled controls with TARGET_DISABLED', async () => {
    html('<div id="s" role="switch" aria-checked="false" aria-disabled="true"></div>');
    const clicks: string[] = [];
    byId('s').addEventListener('click', () => clicks.push('click'));
    expect(await codeOf(makeActions().setChecked(options(true), undefined, byId('s')))).toBe(
      'TARGET_DISABLED'
    );
    expect(clicks).toEqual([]);
  });

  it('rejects a disabled native checkbox with TARGET_DISABLED', async () => {
    html('<input type="checkbox" id="c" disabled>');
    expect(await codeOf(makeActions().setChecked(options(true), undefined, byId('c')))).toBe(
      'TARGET_DISABLED'
    );
  });

  it('keeps the effect uncertain when an abort lands during the settle poll', async () => {
    html('<div id="s" role="switch" aria-checked="false"></div>');
    const controller = new AbortController();
    const guard = createMutationGuard(controller.signal);
    const run = makeActions().setChecked(options(true), guard, byId('s'));
    setTimeout(() => controller.abort(), 30);
    expect(await codeOf(run)).toBe('EXECUTION_CANCELLED');
    expect(guard.committed).toBe(true);
  });
});

describe('setChecked: no guessing', () => {
  it.each([
    ['a plain div', '<div id="t"></div>'],
    ['a text input', '<input id="t" type="text">'],
    ['a role=switch without aria-checked', '<div id="t" role="switch"></div>'],
    ['a button', '<button id="t">Go</button>'],
    ['an unrelated role', '<div id="t" role="button" aria-checked="true"></div>'],
  ])('refuses %s with NOT_CHECKABLE', async (_label, markup) => {
    html(markup);
    const guard = createMutationGuard();
    expect(await codeOf(makeActions().setChecked(options(true), guard, byId('t')))).toBe(
      'NOT_CHECKABLE'
    );
    expect(guard.committed).toBe(false);
  });

  it('does not search descendants or ancestors for a control', async () => {
    html('<div id="wrap"><input type="checkbox" id="c"></div>');
    expect(await codeOf(makeActions().setChecked(options(true), undefined, byId('wrap')))).toBe(
      'NOT_CHECKABLE'
    );
    expect(byId<HTMLInputElement>('c').checked).toBe(false);
    html('<div role="switch" aria-checked="false"><span id="inner"></span></div>');
    expect(await codeOf(makeActions().setChecked(options(true), undefined, byId('inner')))).toBe(
      'NOT_CHECKABLE'
    );
  });
});

describe('setChecked: target resolution', () => {
  it('resolves a CSS selector to one element', async () => {
    html('<input type="checkbox" id="a"><input type="checkbox" id="b">');
    await makeActions().setChecked(options(true, { selector: '#b' }));
    expect(byId<HTMLInputElement>('b').checked).toBe(true);
    expect(byId<HTMLInputElement>('a').checked).toBe(false);
  });

  it('rejects stale and ambiguous selectors and detached targets', async () => {
    html('<input type="checkbox" class="x"><input type="checkbox" class="x">');
    expect(await codeOf(makeActions().setChecked(options(true, { selector: '#gone' })))).toBe(
      'TARGET_STALE'
    );
    expect(await codeOf(makeActions().setChecked(options(true, { selector: '.x' })))).toBe(
      'TARGET_AMBIGUOUS'
    );
    expect(await codeOf(makeActions().setChecked(options(true, { selector: '##[' })))).toBe(
      'VALIDATION_FAILED'
    );
    const detached = document.createElement('input');
    detached.type = 'checkbox';
    expect(await codeOf(makeActions().setChecked(options(true), undefined, detached))).toBe(
      'TARGET_STALE'
    );
    expect(detached.checked).toBe(false);
  });

  it('fails INVALID_ACTION without a target or selector and never text-matches a description', async () => {
    html('<label><input type="checkbox" id="c"> Remember me</label>');
    const guard = createMutationGuard();
    const error = await failureOf(
      makeActions().setChecked(options(true, { description: 'Remember me' }), guard)
    );
    expect(error.code).toBe('INVALID_ACTION');
    expect(byId<HTMLInputElement>('c').checked).toBe(false);
    expect(guard.committed).toBe(false);
    expect(error.message).not.toContain('Remember');
  });
});

describe('setChecked: guard and results', () => {
  it('rejects EXECUTION_CANCELLED before any click for an aborted signal', async () => {
    html('<input type="checkbox" id="c">');
    const controller = new AbortController();
    controller.abort();
    const guard = createMutationGuard(controller.signal);
    expect(await codeOf(makeActions().setChecked(options(true), guard, byId('c')))).toBe(
      'EXECUTION_CANCELLED'
    );
    expect(byId<HTMLInputElement>('c').checked).toBe(false);
    expect(guard.committed).toBe(false);
  });

  it('setChecked of strict.ts returns unions and never throws', async () => {
    html('<div id="t"></div><input type="checkbox" id="c">');
    expect(await setChecked(byId('t'), true, createMutationGuard())).toMatchObject({
      ok: false,
      code: 'NOT_CHECKABLE',
    });
    const controller = new AbortController();
    controller.abort();
    expect(await setChecked(byId('c'), true, createMutationGuard(controller.signal))).toMatchObject(
      {
        ok: false,
        code: 'EXECUTION_CANCELLED',
      }
    );
    const done = await setChecked(byId('c'), true, createMutationGuard());
    expect(done).toEqual({
      ok: true,
      outcome: {
        kind: 'setChecked',
        control: 'native',
        before: false,
        after: true,
        changed: true,
        matched: true,
      },
    });
  });

  it('survives a JSON round trip', async () => {
    html('<input type="checkbox" id="c">');
    const outcome = await makeActions().setChecked(options(true), undefined, byId('c'));
    expect(JSON.parse(JSON.stringify(outcome))).toEqual(outcome);
  });
});

describe('setChecked: runtime type safety', () => {
  it.each(['true', 1, undefined])('rejects the non-boolean checked value %p', async value => {
    html('<input type="checkbox" id="c">');
    const guard = createMutationGuard();
    const code = await codeOf(
      makeActions().setChecked({ checked: value as unknown as boolean }, guard, byId('c'))
    );
    expect(code).toBe('VALIDATION_FAILED');
    expect(byId<HTMLInputElement>('c').checked).toBe(false);
    expect(guard.committed).toBe(false);
  });
});
