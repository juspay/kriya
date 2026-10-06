import { randomBytes } from 'crypto';
import { DOMActions } from '@/actions/DOMActions';
import { createMutationGuard } from '@/actions/guard';
import { fillStrict, resolveStrictElement } from '@/actions/strict';
import type { ErrorCode, FillOptions, MutationGuard } from '@/types';
import { AutomationError, DEFAULT_CONFIG } from '@/types';
import { resetDom } from './helpers/domHarness';

const SECRET = `s${randomBytes(9).toString('hex')}`;

function makeActions(): DOMActions {
  const actions = new DOMActions(DEFAULT_CONFIG);
  actions.initialize();
  return actions;
}

function byId<T extends HTMLElement = HTMLInputElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`fixture is missing #${id}`);
  }
  return element as T;
}

function html(markup: string): void {
  document.body.innerHTML = markup;
}

function fillOptions(overrides: Partial<FillOptions> = {}): FillOptions {
  return { value: 'x', clearFirst: false, triggerEvents: true, ...overrides };
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
    document.addEventListener(type, () => trace.push(type), true);
  }
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

beforeEach(() => {
  resetDom();
});

afterEach(() => {
  jest.restoreAllMocks();
  resetDom();
});

describe('strict fill: exact target resolution', () => {
  it('fills the element a CSS selector resolves to (legacy text matching could never do this)', async () => {
    html('<input id="email" name="email"><input id="other" name="other">');
    const outcome = await makeActions().fill(
      fillOptions({ selector: '#email', value: 'a@b.co', strict: true })
    );
    expect(byId('email').value).toBe('a@b.co');
    expect(byId('other').value).toBe('');
    expect(outcome).toMatchObject({ kind: 'fill', tag: 'input', inputType: 'text', matched: true });
  });

  it('fills a passed target element and implies strict mode without the strict flag', async () => {
    html('<input id="a"><input id="b">');
    const outcome = await makeActions().fill(fillOptions({ value: 'hello' }), undefined, byId('b'));
    expect(byId('b').value).toBe('hello');
    expect(byId('a').value).toBe('');
    expect(outcome).toMatchObject({ kind: 'fill', changed: true, matched: true });
  });

  it('prefers the passed target over a selector that matches another element', async () => {
    html('<input id="a"><input id="b">');
    await makeActions().fill(
      fillOptions({ selector: '#a', value: 'v', strict: true }),
      undefined,
      byId('b')
    );
    expect(byId('b').value).toBe('v');
    expect(byId('a').value).toBe('');
  });

  it('rejects a stale selector with TARGET_STALE and never falls back to the description', async () => {
    html('<label>Email<input id="email"></label><input id="first">');
    const trace: string[] = [];
    const guard = tracedGuard(trace);
    const code = await codeOf(
      makeActions().fill(
        fillOptions({ selector: '#gone', description: 'Email', value: SECRET, strict: true }),
        guard
      )
    );
    expect(code).toBe('TARGET_STALE');
    expect(byId('email').value).toBe('');
    expect(byId('first').value).toBe('');
    expect(guard.committed).toBe(false);
  });

  it('rejects an ambiguous selector with TARGET_AMBIGUOUS and fills neither match', async () => {
    html('<input class="f" id="a"><input class="f" id="b">');
    const guard = createMutationGuard();
    const code = await codeOf(
      makeActions().fill(fillOptions({ selector: '.f', value: 'v', strict: true }), guard)
    );
    expect(code).toBe('TARGET_AMBIGUOUS');
    expect(byId('a').value).toBe('');
    expect(byId('b').value).toBe('');
    expect(guard.committed).toBe(false);
  });

  it('rejects a detached target with TARGET_STALE', async () => {
    html('<input id="a">');
    const detached = byId('a');
    detached.remove();
    const code = await codeOf(makeActions().fill(fillOptions({ value: 'v' }), undefined, detached));
    expect(code).toBe('TARGET_STALE');
    expect(detached.value).toBe('');
  });

  it('rejects a target that lives in another document with TARGET_STALE', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const foreign = frame.contentDocument?.createElement('input');
    if (foreign === undefined) {
      throw new Error('iframe document is unavailable');
    }
    frame.contentDocument?.body.appendChild(foreign);
    const code = await codeOf(makeActions().fill(fillOptions({ value: 'v' }), undefined, foreign));
    expect(code).toBe('TARGET_STALE');
    expect(foreign.value).toBe('');
  });

  it('rejects an invalid selector with VALIDATION_FAILED instead of throwing a DOM error', async () => {
    html('<input id="a">');
    const error = await failureOf(
      makeActions().fill(fillOptions({ selector: '##[bad', strict: true }))
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.name).toBe('AutomationError');
  });

  it('fails INVALID_ACTION with no commit when strict has neither target nor selector, and never text-matches the description', async () => {
    html('<label>Email<input id="email"></label><input id="first">');
    const guard = createMutationGuard();
    const error = await failureOf(
      makeActions().fill(fillOptions({ description: 'Email', value: SECRET, strict: true }), guard)
    );
    expect(error.code).toBe('INVALID_ACTION');
    expect(guard.committed).toBe(false);
    expect(byId('email').value).toBe('');
    expect(byId('first').value).toBe('');
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain('Email');
    expect(JSON.stringify(error.context ?? {})).not.toContain(SECRET);
  });

  it('also fails INVALID_ACTION for strict with an empty selector string', async () => {
    html('<input id="first">');
    const code = await codeOf(makeActions().fill(fillOptions({ selector: '', strict: true })));
    expect(code).toBe('INVALID_ACTION');
    expect(byId('first').value).toBe('');
  });
});

describe('strict fill: editability and no neighbour fallback', () => {
  it('does not retarget a button to a nearby input (legacy would fill the neighbour)', async () => {
    html('<div><button id="pay" aria-label="pay now">Pay</button><input id="card"></div>');
    const code = await codeOf(
      makeActions().fill(fillOptions({ value: 'v' }), undefined, byId('pay'))
    );
    expect(code).toBe('NOT_EDITABLE');
    expect(byId('card').value).toBe('');
  });

  it('does not retarget a checkbox to its text sibling', async () => {
    html('<div><input type="checkbox" id="tick"><input id="note"></div>');
    const code = await codeOf(
      makeActions().fill(fillOptions({ value: 'v' }), undefined, byId('tick'))
    );
    expect(code).toBe('NOT_EDITABLE');
    expect(byId('note').value).toBe('');
    expect(byId('tick').checked).toBe(false);
  });

  it('does not resolve a label to its control', async () => {
    html('<label id="lab" for="name">Name</label><input id="name">');
    const code = await codeOf(
      makeActions().fill(fillOptions({ value: 'v' }), undefined, byId<HTMLElement>('lab'))
    );
    expect(code).toBe('NOT_EDITABLE');
    expect(byId('name').value).toBe('');
  });

  it('rejects contenteditable, select and hidden inputs as NOT_EDITABLE', async () => {
    html(
      '<div id="ce" contenteditable="true">x</div><select id="s"><option>a</option></select><input id="h" type="hidden">'
    );
    for (const id of ['ce', 'h', 's']) {
      const code = await codeOf(
        makeActions().fill(fillOptions({ value: 'v' }), undefined, byId<HTMLElement>(id))
      );
      expect(code).toBe('NOT_EDITABLE');
    }
    expect(byId<HTMLElement>('ce').textContent).toBe('x');
    expect(byId('h').value).toBe('');
  });

  it.each([
    ['disabled attribute', '<input id="t" disabled>', 'TARGET_DISABLED'],
    ['disabled fieldset', '<fieldset disabled><input id="t"></fieldset>', 'TARGET_DISABLED'],
    ['aria-disabled', '<input id="t" aria-disabled="true">', 'TARGET_DISABLED'],
    ['readonly', '<input id="t" readonly>', 'NOT_EDITABLE'],
    ['readonly textarea', '<textarea id="t" readonly></textarea>', 'NOT_EDITABLE'],
  ])('rejects %s without a commit or an event', async (_label, markup, expected) => {
    html(markup);
    const trace: string[] = [];
    recordEvents(['input', 'change', 'focus'], trace);
    const guard = tracedGuard(trace);
    const error = await failureOf(
      makeActions().fill(fillOptions({ value: SECRET }), guard, byId<HTMLElement>('t'))
    );
    expect(error.code).toBe(expected);
    expect(guard.committed).toBe(false);
    expect(trace).toEqual([]);
    expect(error.message).not.toContain(SECRET);
    expect(JSON.stringify(error.context ?? {})).not.toContain(SECRET);
  });

  it.each(['text', 'email', 'password', 'tel', 'url', 'search', 'number'])(
    'accepts an input of type %s',
    async type => {
      html(`<input id="t" type="${type}">`);
      const value = type === 'number' ? '42' : 'ab';
      const outcome = await makeActions().fill(fillOptions({ value }), undefined, byId('t'));
      expect(byId('t').value).toBe(value);
      expect(outcome).toMatchObject({ kind: 'fill', inputType: type, matched: true });
    }
  );

  it('fills a textarea and keeps newlines', async () => {
    html('<textarea id="t"></textarea>');
    const outcome = await makeActions().fill(
      fillOptions({ value: 'a\nb' }),
      undefined,
      byId<HTMLTextAreaElement>('t')
    );
    expect(byId<HTMLTextAreaElement>('t').value).toBe('a\nb');
    expect(outcome).toMatchObject({ kind: 'fill', tag: 'textarea', matched: true, length: 3 });
  });
});

describe('strict fill: events, idempotence and clearing', () => {
  it('dispatches input then change once each, bubbling, after the value is set and after the commit', async () => {
    html('<form id="f"><input id="t"></form>');
    const trace: string[] = [];
    const seen: string[] = [];
    byId<HTMLElement>('f').addEventListener('input', event => {
      seen.push(`input:${(event.target as HTMLInputElement).value}`);
      trace.push('input');
    });
    byId<HTMLElement>('f').addEventListener('change', event => {
      seen.push(`change:${(event.target as HTMLInputElement).value}`);
      trace.push('change');
    });
    const guard = tracedGuard(trace);
    await makeActions().fill(fillOptions({ value: 'v1' }), guard, byId('t'));
    expect(trace).toEqual(['commit', 'input', 'change']);
    expect(seen).toEqual(['input:v1', 'change:v1']);
  });

  it('makes input composed (as a typed character is) and change a plain bubbling event', async () => {
    html('<input id="t">');
    const flags: Record<string, boolean[]> = {};
    for (const type of ['input', 'change']) {
      byId('t').addEventListener(type, event => {
        flags[type] = [event.bubbles, event.cancelable, event.composed];
      });
    }
    await makeActions().fill(fillOptions({ value: 'v1' }), undefined, byId('t'));
    expect(flags).toEqual({ input: [true, false, true], change: [true, false, false] });
  });

  it('commits exactly once and never between the events of one fill', async () => {
    html('<input id="t">');
    const trace: string[] = [];
    recordEvents(['input', 'change'], trace);
    await makeActions().fill(fillOptions({ value: 'v' }), tracedGuard(trace), byId('t'));
    expect(trace.filter(entry => entry === 'commit')).toHaveLength(1);
    expect(trace.indexOf('commit')).toBe(0);
  });

  it("clears with '' and reports a value-free empty outcome", async () => {
    html('<input id="t" value="old">');
    const outcome = await makeActions().fill(fillOptions({ value: '' }), undefined, byId('t'));
    expect(byId('t').value).toBe('');
    expect(outcome).toEqual({
      kind: 'fill',
      tag: 'input',
      inputType: 'text',
      length: 0,
      empty: true,
      changed: true,
      matched: true,
    });
  });

  it("fires input and change when '' clears a filled field", async () => {
    html('<input id="t" value="old">');
    const trace: string[] = [];
    recordEvents(['input', 'change'], trace);
    await makeActions().fill(fillOptions({ value: '' }), undefined, byId('t'));
    expect(trace).toEqual(['input', 'change']);
  });

  it("treats '' on an already empty field as a no-op: no events, no commit", async () => {
    html('<input id="t">');
    const trace: string[] = [];
    recordEvents(['input', 'change', 'focus'], trace);
    const guard = tracedGuard(trace);
    const outcome = await makeActions().fill(fillOptions({ value: '' }), guard, byId('t'));
    expect(trace).toEqual([]);
    expect(guard.committed).toBe(false);
    expect(outcome).toMatchObject({ kind: 'fill', changed: false, matched: true, empty: true });
  });

  it('is idempotent: the same value again is a no-op with changed:false and matched:true', async () => {
    html('<input id="t">');
    const actions = makeActions();
    await actions.fill(fillOptions({ value: 'same' }), undefined, byId('t'));
    const trace: string[] = [];
    recordEvents(['input', 'change'], trace);
    const guard = tracedGuard(trace);
    const outcome = await actions.fill(fillOptions({ value: 'same' }), guard, byId('t'));
    expect(trace).toEqual([]);
    expect(guard.committed).toBe(false);
    expect(outcome).toMatchObject({ changed: false, matched: true, length: 4 });
  });

  it('replaces an existing value and reports changed:true', async () => {
    html('<input id="t" value="old">');
    const outcome = await makeActions().fill(fillOptions({ value: 'new' }), undefined, byId('t'));
    expect(byId('t').value).toBe('new');
    expect(outcome).toMatchObject({ changed: true, matched: true, empty: false });
  });

  it('is case sensitive when deciding that the value is already set', async () => {
    html('<input id="t" value="abc">');
    const outcome = await makeActions().fill(fillOptions({ value: 'ABC' }), undefined, byId('t'));
    expect(byId('t').value).toBe('ABC');
    expect(outcome).toMatchObject({ changed: true, matched: true });
  });

  it('focuses the field it fills', async () => {
    html('<input id="t"><input id="u">');
    await makeActions().fill(fillOptions({ value: 'v' }), undefined, byId('t'));
    expect(document.activeElement).toBe(byId('t'));
  });

  it('ignores clearFirst and triggerEvents of the legacy options: one write, both events', async () => {
    html('<input id="t" value="old">');
    const trace: string[] = [];
    recordEvents(['input', 'change'], trace);
    await makeActions().fill(
      fillOptions({ value: 'new', clearFirst: true, triggerEvents: false }),
      undefined,
      byId('t')
    );
    expect(trace).toEqual(['input', 'change']);
    expect(byId('t').value).toBe('new');
  });
});

describe('strict fill: native setter and sanitization', () => {
  function installReactTracker(input: HTMLInputElement): {
    changes: string[];
    setterCalls: number;
  } {
    const proto = Object.getPrototypeOf(input) as object;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.get === undefined || descriptor.set === undefined) {
      throw new Error('missing native value accessor');
    }
    const { get, set } = descriptor;
    const state = { tracked: input.value, setterCalls: 0, changes: [] as string[] };
    Object.defineProperty(input, 'value', {
      configurable: true,
      get(this: HTMLInputElement): string {
        return get.call(this) as string;
      },
      set(this: HTMLInputElement, next: string) {
        state.setterCalls += 1;
        state.tracked = String(next);
        set.call(this, next);
      },
    });
    input.addEventListener('input', () => {
      const current = get.call(input) as string;
      if (current !== state.tracked) {
        state.changes.push(current);
        state.tracked = current;
      }
    });
    return state;
  }

  it('bypasses the instance-level value property so a React-style tracker sees the change', async () => {
    html('<input id="t">');
    const tracker = installReactTracker(byId('t'));
    await makeActions().fill(fillOptions({ value: 'typed' }), undefined, byId('t'));
    expect(tracker.setterCalls).toBe(0);
    expect(tracker.changes).toEqual(['typed']);
    expect(byId('t').value).toBe('typed');
  });

  it('control: a plain value assignment is invisible to the same tracker', () => {
    html('<input id="t">');
    const tracker = installReactTracker(byId('t'));
    byId('t').value = 'typed';
    byId('t').dispatchEvent(new Event('input', { bubbles: true }));
    expect(tracker.changes).toEqual([]);
  });

  it('fills an element that was created in another realm and adopted into the document', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const foreign = frame.contentDocument?.createElement('input');
    if (foreign === undefined) {
      throw new Error('iframe document is unavailable');
    }
    foreign.id = 'adopted';
    document.body.appendChild(foreign);
    const outcome = await makeActions().fill(fillOptions({ value: 'ok' }), undefined, foreign);
    expect(foreign.value).toBe('ok');
    expect(outcome).toMatchObject({ kind: 'fill', matched: true });
  });

  it('reports type=number sanitization as matched:false on a committed write', async () => {
    html('<input id="n" type="number">');
    const trace: string[] = [];
    const guard = tracedGuard(trace);
    const outcome = await makeActions().fill(fillOptions({ value: 'abc' }), guard, byId('n'));
    expect(byId('n').value).toBe('');
    expect(outcome).toMatchObject({
      kind: 'fill',
      inputType: 'number',
      matched: false,
      empty: true,
    });
    expect(guard.committed).toBe(true);
  });

  it('reports matched:true for a valid number', async () => {
    html('<input id="n" type="number">');
    const outcome = await makeActions().fill(fillOptions({ value: '12.5' }), undefined, byId('n'));
    expect(outcome).toMatchObject({ matched: true, length: 4 });
  });

  it('reports a value that the page rewrites after the write as matched:false', async () => {
    html('<input id="t">');
    byId('t').addEventListener('input', event => {
      const input = event.target as HTMLInputElement;
      input.value = input.value.toUpperCase();
    });
    const outcome = await makeActions().fill(fillOptions({ value: 'abc' }), undefined, byId('t'));
    expect(byId('t').value).toBe('ABC');
    expect(outcome).toMatchObject({ matched: false, changed: true });
  });
});

describe('strict fill: value-free outcomes and sensitive fields', () => {
  it('never puts the typed value in the outcome', async () => {
    html('<input id="t">');
    const outcome = await makeActions().fill(fillOptions({ value: SECRET }), undefined, byId('t'));
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(Object.keys(outcome ?? {}).sort()).toEqual(
      ['changed', 'empty', 'inputType', 'kind', 'length', 'matched', 'tag'].sort()
    );
  });

  it('reports the length of a non-sensitive value', async () => {
    html('<input id="t">');
    const outcome = await makeActions().fill(fillOptions({ value: 'four' }), undefined, byId('t'));
    expect(outcome).toMatchObject({ length: 4, empty: false });
  });

  it.each([
    ['password input', '<input id="t" type="password">'],
    ['cc autocomplete', '<input id="t" autocomplete="cc-number">'],
    ['new-password autocomplete', '<input id="t" autocomplete="new-password">'],
    ['one-time-code autocomplete', '<input id="t" autocomplete="one-time-code">'],
    ['data-kriya-sensitive', '<input id="t" data-kriya-sensitive>'],
    ['data-kriya-sensitive=true', '<input id="t" data-kriya-sensitive="true">'],
  ])(
    'omits length for a structurally sensitive target (%s) and reports empty only',
    async (_l, markup) => {
      html(markup);
      const outcome = await makeActions().fill(
        fillOptions({ value: SECRET }),
        undefined,
        byId('t')
      );
      expect(outcome).toMatchObject({ kind: 'fill', empty: false, matched: true });
      expect(outcome).not.toHaveProperty('length');
      expect(JSON.stringify(outcome)).not.toContain(SECRET);
    }
  );

  it('does not treat data-kriya-sensitive="false" as sensitive', async () => {
    html('<input id="t" data-kriya-sensitive="false">');
    const outcome = await makeActions().fill(fillOptions({ value: 'abc' }), undefined, byId('t'));
    expect(outcome).toHaveProperty('length', 3);
  });

  it('omits length when the caller marks the value sensitive, on a plain text field', async () => {
    html('<input id="t">');
    const outcome = await makeActions().fill(
      fillOptions({ value: SECRET }),
      undefined,
      byId('t'),
      true
    );
    expect(outcome).not.toHaveProperty('length');
    expect(outcome).toMatchObject({ empty: false, changed: true, matched: true });
  });

  it("still reports empty:true and no length when a sensitive field is cleared with ''", async () => {
    html('<input id="t" type="password" value="hunter2">');
    const outcome = await makeActions().fill(fillOptions({ value: '' }), undefined, byId('t'));
    expect(outcome).not.toHaveProperty('length');
    expect(outcome).toMatchObject({ empty: true, changed: true });
  });

  it('keeps the value out of every failure message and context', async () => {
    html('<input id="t" disabled>');
    const error = await failureOf(
      makeActions().fill(fillOptions({ value: SECRET }), undefined, byId('t'))
    );
    expect(`${error.message} ${JSON.stringify(error.context ?? {})}`).not.toContain(SECRET);
  });
});

describe('strict fill: guard and cancellation', () => {
  it('rejects EXECUTION_CANCELLED for an already aborted signal and leaves the page untouched', async () => {
    html('<input id="t" value="keep">');
    const trace: string[] = [];
    recordEvents(['input', 'change'], trace);
    const guard = createMutationGuard(abortedSignal());
    const code = await codeOf(makeActions().fill(fillOptions({ value: 'v' }), guard, byId('t')));
    expect(code).toBe('EXECUTION_CANCELLED');
    expect(byId('t').value).toBe('keep');
    expect(trace).toEqual([]);
    expect(guard.committed).toBe(false);
  });

  it('an abort that lands between resolution and the write (commit throws) leaves effect none', async () => {
    html('<input id="t" value="keep">');
    const controller = new AbortController();
    const inner = createMutationGuard(controller.signal);
    const guard: MutationGuard = {
      get committed(): boolean {
        return inner.committed;
      },
      checkpoint: (): void => inner.checkpoint(),
      commit: (): void => {
        controller.abort();
        inner.commit();
      },
    };
    const code = await codeOf(makeActions().fill(fillOptions({ value: 'v' }), guard, byId('t')));
    expect(code).toBe('EXECUTION_CANCELLED');
    expect(byId('t').value).toBe('keep');
    expect(guard.committed).toBe(false);
  });

  it('a no-op fill under an aborted signal still reports nothing committed', async () => {
    html('<input id="t" value="same">');
    const guard = createMutationGuard();
    await makeActions().fill(fillOptions({ value: 'same' }), guard, byId('t'));
    expect(guard.committed).toBe(false);
  });
});

describe('strict.ts functions return unions and never throw', () => {
  it('resolveStrictElement maps every failure to a typed result', () => {
    html('<input class="d"><input class="d"><input id="one">');
    expect(resolveStrictElement('##[', undefined)).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
    expect(resolveStrictElement('.none', undefined)).toMatchObject({
      ok: false,
      code: 'TARGET_STALE',
    });
    expect(resolveStrictElement('.d', undefined)).toMatchObject({
      ok: false,
      code: 'TARGET_AMBIGUOUS',
    });
    expect(resolveStrictElement(undefined, undefined)).toMatchObject({
      ok: false,
      code: 'INVALID_ACTION',
    });
    expect(resolveStrictElement('', undefined)).toMatchObject({
      ok: false,
      code: 'INVALID_ACTION',
    });
    const found = resolveStrictElement('#one', undefined);
    expect(found.ok && found.element).toBe(byId('one'));
    const detached = document.createElement('input');
    expect(resolveStrictElement(undefined, detached)).toMatchObject({
      ok: false,
      code: 'TARGET_STALE',
    });
  });

  it('resolveStrictElement treats a null or non-element target as stale instead of throwing', () => {
    html('<input id="one">');
    for (const hostile of [null, {}, 7, 'input', document.createTextNode('x')]) {
      expect(resolveStrictElement('#one', hostile as unknown as HTMLElement)).toMatchObject({
        ok: false,
        code: 'TARGET_STALE',
      });
    }
  });

  it('fillStrict converts a throwing guard into a failure result instead of throwing', () => {
    html('<input id="t">');
    const guard = createMutationGuard(abortedSignal());
    const result = fillStrict(byId('t'), 'v', guard);
    expect(result).toMatchObject({ ok: false, code: 'EXECUTION_CANCELLED' });
    expect(byId('t').value).toBe('');
  });

  it('fillStrict returns the outcome on success', () => {
    html('<input id="t">');
    const result = fillStrict(byId('t'), 'v', createMutationGuard());
    expect(result).toEqual({
      ok: true,
      outcome: {
        kind: 'fill',
        tag: 'input',
        inputType: 'text',
        length: 1,
        empty: false,
        changed: true,
        matched: true,
      },
    });
  });

  it('every failure message is a non-empty string', () => {
    html('<input id="t" disabled>');
    const result = fillStrict(byId('t'), 'v', createMutationGuard());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

describe('legacy fill keeps working beside strict mode', () => {
  it('still resolves by description text and returns no outcome', async () => {
    html('<label for="zip">Zip code</label><input id="zip" name="zip" placeholder="Zip">');
    const result = await makeActions().fill(
      fillOptions({ description: 'Zip', value: '12345', clearFirst: false, triggerEvents: true })
    );
    expect(byId('zip').value).toBe('12345');
    expect(result).toBeUndefined();
  });

  it('still treats a CSS selector as plain text, pinned as legacy behavior', async () => {
    html('<input id="email" name="email" placeholder="Work email">');
    const code = await codeOf(makeActions().fill(fillOptions({ selector: '#email', value: 'v' })));
    expect(code).toBe('ELEMENT_NOT_FOUND');
    expect(byId('email').value).toBe('');
  });

  it("accepts a blank value ('' clears) on the legacy path", async () => {
    html('<input id="email" name="email" value="old">');
    await makeActions().fill(fillOptions({ selector: 'email', value: '' }));
    expect(byId('email').value).toBe('');
  });

  it('commits right before the first write and leaves the field alone when the guard aborts first', async () => {
    html('<input id="email" name="email" value="old">');
    const trace: string[] = [];
    recordEvents(['input', 'change'], trace);
    await makeActions().fill(fillOptions({ selector: 'email', value: 'new' }), tracedGuard(trace));
    expect(trace).toEqual(['commit', 'input', 'change']);

    const aborted = createMutationGuard(abortedSignal());
    const code = await codeOf(
      makeActions().fill(fillOptions({ selector: 'email', value: 'third' }), aborted)
    );
    expect(code).toBe('EXECUTION_CANCELLED');
    expect(byId('email').value).toBe('new');
    expect(aborted.committed).toBe(false);
  });

  it('never puts the value in the select failure message or thrown context', async () => {
    html('<select id="s" name="country"><option value="us">US</option></select>');
    const error = await failureOf(
      makeActions().fill(fillOptions({ selector: 'country', value: SECRET }))
    );
    expect(error.code).toBe('EXECUTION_FAILED');
    expect(
      `${error.message} ${JSON.stringify(error.context ?? {}, (_k, v) => (v instanceof Error ? v.message : v))}`
    ).not.toContain(SECRET);
  });

  it('refuses a blank value on a ReScript SelectBox before any click', async () => {
    html(
      '<div data-selectbox-value="a"><input id="pick" name="pick"><button id="trigger" data-value="a">A</button></div>'
    );
    const clicks: string[] = [];
    byId<HTMLElement>('trigger').addEventListener('click', () => clicks.push('click'));
    const guard = createMutationGuard();
    const code = await codeOf(
      makeActions().fill(fillOptions({ selector: 'pick', value: '' }), guard)
    );
    expect(code).toBe('VALIDATION_FAILED');
    expect(clicks).toEqual([]);
    expect(guard.committed).toBe(false);
  });
});

describe('strict fill: runtime type safety', () => {
  it.each([undefined, null, 42, {}])(
    'rejects the non-string value %p without writing anything',
    async value => {
      html('<input id="t" value="keep">');
      const trace: string[] = [];
      recordEvents(['input', 'change'], trace);
      const guard = createMutationGuard();
      const code = await codeOf(
        makeActions().fill(fillOptions({ value: value as unknown as string }), guard, byId('t'))
      );
      expect(code).toBe('VALIDATION_FAILED');
      expect(byId('t').value).toBe('keep');
      expect(trace).toEqual([]);
      expect(guard.committed).toBe(false);
    }
  );
});

describe('legacy SelectBox fill awaits its dropdown and honors cancellation', () => {
  const SELECTBOX = `
    <div data-selectbox-value="a">
      <input id="pick" name="pick">
      <button id="trigger" data-value="a">A</button>
      <ul role="listbox"><li id="optb" data-dropdown-value="b">B</li></ul>
    </div>`;

  async function fillSelectBox(signal: AbortSignal | undefined, abortWhilePending: boolean) {
    html(SELECTBOX);
    const clicks: string[] = [];
    const controller = new AbortController();
    byId<HTMLElement>('trigger').addEventListener('click', () => {
      clicks.push('trigger');
      if (abortWhilePending) {
        controller.abort();
      }
    });
    byId<HTMLElement>('optb').addEventListener('click', () => clicks.push('option'));
    const guard = createMutationGuard(signal ?? controller.signal);
    const pending = makeActions().fill(
      fillOptions({ selector: 'pick', value: 'b' }),
      guard,
      undefined,
      false,
      signal ?? controller.signal
    );
    if (abortWhilePending) {
      expect(await codeOf(pending)).toBe('EXECUTION_CANCELLED');
    } else {
      await pending;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    return clicks;
  }

  it('control: without an abort the option is clicked after the dropdown opens', async () => {
    expect(await fillSelectBox(undefined, false)).toEqual(['trigger', 'option']);
  });

  it('does not click the option when the signal aborts before the timer fires', async () => {
    expect(await fillSelectBox(undefined, true)).toEqual(['trigger']);
  });
});
