import { DOMActions } from '@/actions/DOMActions';
import { createMutationGuard } from '@/actions/guard';
import { canImplicitlySubmit, pressStrict } from '@/actions/strict';
import type { ErrorCode, MutationGuard, PressOptions } from '@/types';
import { AutomationError, DEFAULT_CONFIG, TASK_KEYS } from '@/types';
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

function press(key: string, overrides: Partial<PressOptions> = {}): PressOptions {
  return { key, ...overrides };
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

const KEY_EVENTS = ['keydown', 'keypress', 'keyup'] as const;

type KeySample = {
  readonly type: string;
  readonly target: string;
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly which: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
};

function recordKeys(samples: KeySample[]): void {
  for (const type of KEY_EVENTS) {
    document.addEventListener(
      type,
      event => {
        const key = event as KeyboardEvent;
        samples.push({
          type,
          target: (event.target as HTMLElement).id || (event.target as HTMLElement).tagName,
          key: key.key,
          code: key.code,
          keyCode: key.keyCode,
          which: key.which,
          bubbles: key.bubbles,
          cancelable: key.cancelable,
        });
      },
      true
    );
  }
}

function recordTypes(types: readonly string[], trace: string[]): void {
  for (const type of types) {
    document.addEventListener(
      type,
      event => trace.push(`${type}@${(event.target as HTMLElement).id}`),
      true
    );
  }
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

const FORM_WITH_BUTTON =
  '<form id="f"><input id="q" value="term"><button id="go">Search</button></form>';

function preventSubmits(): void {
  document.addEventListener('submit', event => event.preventDefault());
}

function mountShadow(markup: string): ShadowRoot {
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = markup;
  return root;
}

function inShadow<T extends HTMLElement = HTMLElement>(root: ShadowRoot, id: string): T {
  const element = root.getElementById(id);
  if (element === null) {
    throw new Error(`fixture is missing #${id} in the shadow root`);
  }
  return element as T;
}

beforeEach(() => {
  resetDom();
});

afterEach(() => {
  jest.restoreAllMocks();
  resetDom();
});

describe('press: key table', () => {
  it.each([
    ['Enter', 'Enter', 13],
    ['Escape', 'Escape', 27],
    ['Tab', 'Tab', 9],
    ['Backspace', 'Backspace', 8],
    ['Delete', 'Delete', 46],
    ['ArrowUp', 'ArrowUp', 38],
    ['ArrowDown', 'ArrowDown', 40],
    ['ArrowLeft', 'ArrowLeft', 37],
    ['ArrowRight', 'ArrowRight', 39],
    ['Home', 'Home', 36],
    ['End', 'End', 35],
    ['PageUp', 'PageUp', 33],
    ['PageDown', 'PageDown', 34],
    [' ', 'Space', 32],
    ['a', 'KeyA', 65],
    ['A', 'KeyA', 65],
    ['z', 'KeyZ', 90],
    ['0', 'Digit0', 48],
    ['7', 'Digit7', 55],
  ])('dispatches %j with code %s and keyCode %d on the target', async (key, code, keyCode) => {
    html('<input id="t">');
    const samples: KeySample[] = [];
    recordKeys(samples);
    await makeActions().press(press(key), undefined, byId('t'));
    expect(samples.length).toBeGreaterThanOrEqual(2);
    for (const sample of samples) {
      expect(sample).toMatchObject({
        target: 't',
        key,
        code,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
      });
    }
  });

  it('covers every protocol key', async () => {
    html('<input id="t">');
    for (const name of TASK_KEYS) {
      const samples: KeySample[] = [];
      const listener = (event: Event): void => {
        samples.push({ type: event.type } as KeySample);
      };
      document.addEventListener('keydown', listener, true);
      const key = name === 'Space' ? ' ' : name;
      await makeActions().press(press(key), undefined, byId('t'));
      document.removeEventListener('keydown', listener, true);
      expect(samples).toHaveLength(1);
    }
  });

  it('gives keypress a charCode (13 for Enter, the character for printable keys) and every other event 0', async () => {
    html('<input id="t">');
    const codes: Record<string, number[]> = {};
    for (const type of KEY_EVENTS) {
      document.addEventListener(
        type,
        event => {
          const list = codes[type] ?? [];
          list.push((event as KeyboardEvent).charCode);
          codes[type] = list;
        },
        true
      );
    }
    await makeActions().press(press('Enter'), undefined, byId('t'));
    await makeActions().press(press('a'), undefined, byId('t'));
    await makeActions().press(press('Escape'), undefined, byId('t'));
    expect(codes).toEqual({ keydown: [0, 0, 0], keypress: [13, 97], keyup: [0, 0, 0] });
  });

  it('accepts the protocol name Space and sends the space character', async () => {
    html('<input id="t">');
    const samples: KeySample[] = [];
    recordKeys(samples);
    await makeActions().press(press('Space'), undefined, byId('t'));
    expect(samples.map(sample => sample.key)).toEqual([' ', ' ', ' ']);
    expect(samples[0]?.code).toBe('Space');
  });

  it('sends keypress only for Enter and printable keys', async () => {
    html('<input id="t">');
    const printable: Record<string, readonly string[]> = {
      Enter: ['keydown', 'keypress', 'keyup'],
      a: ['keydown', 'keypress', 'keyup'],
      ' ': ['keydown', 'keypress', 'keyup'],
      Escape: ['keydown', 'keyup'],
      ArrowDown: ['keydown', 'keyup'],
      Tab: ['keydown', 'keyup'],
      Backspace: ['keydown', 'keyup'],
    };
    for (const [key, expected] of Object.entries(printable)) {
      const samples: KeySample[] = [];
      const listener = (event: Event): void => {
        samples.push({ type: event.type } as KeySample);
      };
      for (const type of KEY_EVENTS) {
        document.addEventListener(type, listener, true);
      }
      await makeActions().press(press(key), undefined, byId('t'));
      for (const type of KEY_EVENTS) {
        document.removeEventListener(type, listener, true);
      }
      expect(samples.map(sample => sample.type)).toEqual(expected);
    }
  });

  it.each(['', 'F13', 'Foo', 'enter', 'ab', 'Control'])(
    'rejects the unsupported key %j with VALIDATION_FAILED and sends no event',
    async key => {
      html('<input id="t">');
      const samples: KeySample[] = [];
      recordKeys(samples);
      const guard = createMutationGuard();
      expect(await codeOf(makeActions().press(press(key), guard, byId('t')))).toBe(
        'VALIDATION_FAILED'
      );
      expect(samples).toEqual([]);
      expect(guard.committed).toBe(false);
    }
  );

  it('focuses the target and delivers the keys to it', async () => {
    html('<input id="a"><input id="b">');
    const samples: KeySample[] = [];
    recordKeys(samples);
    await makeActions().press(press('x'), undefined, byId('b'));
    expect(document.activeElement).toBe(byId('b'));
    expect(new Set(samples.map(sample => sample.target))).toEqual(new Set(['b']));
  });

  it('returns a value-free press outcome with no default action when implicitSubmit is off', async () => {
    html(FORM_WITH_BUTTON);
    const trace: string[] = [];
    recordTypes(['submit', 'click'], trace);
    const outcome = await makeActions().press(press('Enter'), undefined, byId('q'));
    expect(outcome).toEqual({ kind: 'press', defaultPrevented: false, defaultAction: 'none' });
    expect(trace).toEqual([]);
  });
});

describe('press: no fallback target', () => {
  it('rejects a stale selector with TARGET_STALE and delivers no key anywhere', async () => {
    html('<input id="first"><input id="second">');
    const samples: KeySample[] = [];
    recordKeys(samples);
    const guard = createMutationGuard();
    const code = await codeOf(
      makeActions().press(press('Enter', { selector: '#gone', strict: true }), guard)
    );
    expect(code).toBe('TARGET_STALE');
    expect(samples).toEqual([]);
    expect(guard.committed).toBe(false);
  });

  it('fails INVALID_ACTION when strict has neither target nor selector, even with a description or an active input', async () => {
    html('<input id="first"><input id="second" placeholder="Search">');
    byId('second').focus();
    const samples: KeySample[] = [];
    recordKeys(samples);
    const guard = createMutationGuard();
    const error = await failureOf(
      makeActions().press(press('Enter', { description: 'Search', strict: true }), guard)
    );
    expect(error.code).toBe('INVALID_ACTION');
    expect(samples).toEqual([]);
    expect(guard.committed).toBe(false);
    expect(error.message).not.toContain('Search');
  });

  it('rejects ambiguous and invalid selectors and detached targets', async () => {
    html('<input class="x"><input class="x">');
    const samples: KeySample[] = [];
    recordKeys(samples);
    expect(await codeOf(makeActions().press(press('a', { selector: '.x', strict: true })))).toBe(
      'TARGET_AMBIGUOUS'
    );
    expect(await codeOf(makeActions().press(press('a', { selector: '##[', strict: true })))).toBe(
      'VALIDATION_FAILED'
    );
    const detached = document.createElement('input');
    expect(await codeOf(makeActions().press(press('a'), undefined, detached))).toBe('TARGET_STALE');
    expect(samples).toEqual([]);
  });

  it('presses the element a CSS selector resolves to, and a passed target implies strict', async () => {
    html('<input id="a"><input id="b">');
    const samples: KeySample[] = [];
    recordKeys(samples);
    await makeActions().press(press('x', { selector: '#b', strict: true }));
    await makeActions().press(press('y', { selector: '#a' }), undefined, byId('b'));
    expect(new Set(samples.map(sample => sample.target))).toEqual(new Set(['b']));
  });

  it('pins the legacy fallback: without strict a missing target still goes to the first input', async () => {
    html('<input id="first"><input id="second">');
    const samples: KeySample[] = [];
    recordKeys(samples);
    const result = await makeActions().press(press('a'));
    expect(result).toBeUndefined();
    expect(new Set(samples.map(sample => sample.target))).toEqual(new Set(['first']));
  });

  it('rejects a disabled control with TARGET_DISABLED and sends no event', async () => {
    html(
      '<input id="a" disabled><fieldset disabled><input id="b"></fieldset><button id="c" aria-disabled="true">x</button>'
    );
    const samples: KeySample[] = [];
    recordKeys(samples);
    for (const id of ['a', 'b', 'c']) {
      expect(await codeOf(makeActions().press(press('Enter'), undefined, byId(id)))).toBe(
        'TARGET_DISABLED'
      );
    }
    expect(samples).toEqual([]);
  });

  it('delivers keys to a non-control element such as a dialog container', async () => {
    html('<div id="dialog" role="dialog" tabindex="-1"></div>');
    const samples: KeySample[] = [];
    recordKeys(samples);
    await makeActions().press(press('Escape'), undefined, byId('dialog'));
    expect(samples.map(sample => sample.type)).toEqual(['keydown', 'keyup']);
  });
});

describe('press: Enter implicit submission', () => {
  it('submits through the default button: keydown, keypress, submit, keyup, once', async () => {
    html(FORM_WITH_BUTTON);
    preventSubmits();
    const trace: string[] = [];
    const submitters: Array<string | undefined> = [];
    document.addEventListener('submit', event => {
      submitters.push((event as SubmitEvent).submitter?.id);
    });
    recordTypes(['keydown', 'keypress', 'submit', 'keyup'], trace);
    const outcome = await makeActions().press(
      press('Enter', { implicitSubmit: true }),
      tracedGuard(trace),
      byId('q')
    );
    expect(trace).toEqual(['commit', 'keydown@q', 'keypress@q', 'submit@f', 'keyup@q']);
    expect(submitters).toEqual(['go']);
    expect(outcome).toEqual({
      kind: 'press',
      defaultPrevented: false,
      defaultAction: 'implicit_submit',
      submit: { event: true, invalidControls: 0, defaultPrevented: true },
    });
  });

  it('activates the default submit button once for implicit Enter submission', async () => {
    html(FORM_WITH_BUTTON);
    preventSubmits();
    const requestSubmit = jest.spyOn(byId<HTMLFormElement>('f'), 'requestSubmit');
    const buttonClicks: string[] = [];
    byId('go').addEventListener('click', () => buttonClicks.push('click'));
    await makeActions().press(press('Enter', { implicitSubmit: true }), undefined, byId('q'));
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(buttonClicks).toEqual(['click']);
  });

  it('calls requestSubmit without a submitter when the form has no button', async () => {
    html('<form id="f"><input id="q" value="term"></form>');
    preventSubmits();
    const requestSubmit = jest.spyOn(byId<HTMLFormElement>('f'), 'requestSubmit');
    await makeActions().press(press('Enter', { implicitSubmit: true }), undefined, byId('q'));
    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(requestSubmit).toHaveBeenCalledWith();
  });

  it('honors a default submitter click handler that prevents implicit submission', async () => {
    html(FORM_WITH_BUTTON);
    const clicks = jest.fn();
    const submits = jest.fn();
    byId('go').addEventListener('click', event => {
      clicks();
      event.preventDefault();
    });
    byId('f').addEventListener('submit', submits);
    const result = await makeActions().press(
      press('Enter', { implicitSubmit: true }),
      undefined,
      byId('q')
    );
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(submits).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: 'press',
      defaultAction: 'implicit_submit',
      submit: { event: false },
    });
  });

  it('submits a form that has no button when the field is the only one', async () => {
    html('<form id="f"><input id="q" value="term"></form>');
    preventSubmits();
    const trace: string[] = [];
    recordTypes(['submit'], trace);
    const outcome = await makeActions().press(
      press('Enter', { implicitSubmit: true }),
      undefined,
      byId('q')
    );
    expect(trace).toEqual(['submit@f']);
    expect(outcome).toMatchObject({ defaultAction: 'implicit_submit', submit: { event: true } });
  });

  it('does not submit a button-less form with two fields', async () => {
    html('<form id="f"><input id="q"><input id="r"></form>');
    const trace: string[] = [];
    recordTypes(['submit'], trace);
    const outcome = await makeActions().press(
      press('Enter', { implicitSubmit: true }),
      undefined,
      byId('q')
    );
    expect(trace).toEqual([]);
    expect(outcome).toEqual({ kind: 'press', defaultPrevented: false, defaultAction: 'none' });
  });

  it('does not submit when the default button is disabled', async () => {
    html('<form id="f"><input id="q"><button id="go" disabled>Go</button></form>');
    const trace: string[] = [];
    recordTypes(['submit'], trace);
    const outcome = await makeActions().press(
      press('Enter', { implicitSubmit: true }),
      undefined,
      byId('q')
    );
    expect(trace).toEqual([]);
    expect(outcome).toMatchObject({ defaultAction: 'none' });
  });

  it('reports a validation-blocked implicit submit: no submit event, one invalid control', async () => {
    html('<form id="f"><input id="q" required><button id="go">Go</button></form>');
    const trace: string[] = [];
    recordTypes(['submit', 'invalid'], trace);
    const outcome = await makeActions().press(
      press('Enter', { implicitSubmit: true }),
      undefined,
      byId('q')
    );
    expect(trace).toEqual(['invalid@q']);
    expect(outcome).toEqual({
      kind: 'press',
      defaultPrevented: false,
      defaultAction: 'implicit_submit',
      submit: { event: false, invalidControls: 1, defaultPrevented: false },
    });
  });

  it('does not submit when the page cancels keydown, and still sends keyup', async () => {
    html(FORM_WITH_BUTTON);
    byId('q').addEventListener('keydown', event => event.preventDefault());
    const trace: string[] = [];
    recordTypes(['keydown', 'keypress', 'keyup', 'submit'], trace);
    const outcome = await makeActions().press(
      press('Enter', { implicitSubmit: true }),
      undefined,
      byId('q')
    );
    expect(trace).toEqual(['keydown@q', 'keyup@q']);
    expect(outcome).toEqual({ kind: 'press', defaultPrevented: true, defaultAction: 'none' });
  });

  it('does not submit when the page cancels keypress', async () => {
    html(FORM_WITH_BUTTON);
    byId('q').addEventListener('keypress', event => event.preventDefault());
    const trace: string[] = [];
    recordTypes(['submit'], trace);
    const outcome = await makeActions().press(
      press('Enter', { implicitSubmit: true }),
      undefined,
      byId('q')
    );
    expect(trace).toEqual([]);
    expect(outcome).toMatchObject({ defaultPrevented: true, defaultAction: 'none' });
  });

  it('does not submit a shadow-root form that has two fields and no button, as a browser would not', async () => {
    const root = mountShadow('<form id="f"><input id="t" type="text"><input type="text"></form>');
    const submits: string[] = [];
    inShadow(root, 'f').addEventListener('submit', () => submits.push('submit'));
    const outcome = await makeActions().press(
      press('Enter', { implicitSubmit: true }),
      undefined,
      inShadow(root, 't')
    );
    expect(outcome).toEqual({ kind: 'press', defaultPrevented: false, defaultAction: 'none' });
    expect(submits).toEqual([]);
  });

  it('submits a shadow-root form through its default button and reports the submit event', async () => {
    const root = mountShadow(
      '<form id="f"><input id="t" type="text" value="x"><button id="go">Go</button></form>'
    );
    const submitters: (Element | null)[] = [];
    inShadow(root, 'f').addEventListener('submit', event => {
      submitters.push((event as SubmitEvent).submitter);
      event.preventDefault();
    });
    const outcome = await makeActions().press(
      press('Enter', { implicitSubmit: true }),
      undefined,
      inShadow(root, 't')
    );
    expect(outcome).toEqual({
      kind: 'press',
      defaultPrevented: false,
      defaultAction: 'implicit_submit',
      submit: { event: true, invalidControls: 0, defaultPrevented: true },
    });
    expect(submitters).toEqual([inShadow(root, 'go')]);
  });

  it('never submits for other keys, and never for textarea, select, checkbox or an input outside a form', async () => {
    html(
      FORM_WITH_BUTTON +
        '<form><textarea id="ta"></textarea><select id="sel"><option>a</option></select><input type="checkbox" id="cb"><button>Go</button></form><input id="loose">'
    );
    const trace: string[] = [];
    recordTypes(['submit', 'click'], trace);
    await makeActions().press(press('a', { implicitSubmit: true }), undefined, byId('q'));
    for (const id of ['ta', 'sel', 'cb', 'loose']) {
      await makeActions().press(press('Enter', { implicitSubmit: true }), undefined, byId(id));
    }
    expect(trace).toEqual([]);
  });
});

describe('press: default action of Enter and Space', () => {
  it('activates a button on Enter with exactly one click, between keypress and keyup', async () => {
    html('<button id="b">Go</button>');
    const trace: string[] = [];
    recordTypes(['keydown', 'keypress', 'click', 'keyup'], trace);
    const click = jest.spyOn(byId('b'), 'click');
    const outcome = await makeActions().press(
      press('Enter', { implicitSubmit: true }),
      undefined,
      byId('b')
    );
    expect(trace).toEqual(['keydown@b', 'keypress@b', 'click@b', 'keyup@b']);
    expect(click).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'press', defaultPrevented: false, defaultAction: 'activate' });
  });

  it('activates a button on Space after keyup', async () => {
    html('<button id="b">Go</button>');
    const trace: string[] = [];
    recordTypes(['keydown', 'keypress', 'keyup', 'click'], trace);
    const outcome = await makeActions().press(
      press(' ', { implicitSubmit: true }),
      undefined,
      byId('b')
    );
    expect(trace).toEqual(['keydown@b', 'keypress@b', 'keyup@b', 'click@b']);
    expect(outcome).toMatchObject({ defaultAction: 'activate' });
  });

  it('toggles a radio on Space, once, and not on Enter', async () => {
    html('<input id="r" type="radio" name="g">');
    const trace: string[] = [];
    recordTypes(['click'], trace);
    await makeActions().press(press('Enter', { implicitSubmit: true }), undefined, byId('r'));
    expect(byId<HTMLInputElement>('r').checked).toBe(false);
    const outcome = await makeActions().press(
      press('Space', { implicitSubmit: true }),
      undefined,
      byId('r')
    );
    expect(byId<HTMLInputElement>('r').checked).toBe(true);
    expect(trace).toEqual(['click@r']);
    expect(outcome).toMatchObject({ defaultAction: 'activate' });
  });

  it.each([
    ['a summary', '<details><summary id="t">More</summary>Body</details>', 'summary'],
    ['an input[type=button]', '<input id="t" type="button" value="Go">', 'input'],
    ['an input[type=reset]', '<form><input id="t" type="reset"></form>', 'input'],
  ])('activates %s on Enter with exactly one click', async (_label, markup) => {
    html(markup);
    const trace: string[] = [];
    recordTypes(['click'], trace);
    const outcome = await makeActions().press(
      press('Enter', { implicitSubmit: true }),
      undefined,
      byId('t')
    );
    expect(trace).toEqual(['click@t']);
    expect(outcome).toMatchObject({ defaultAction: 'activate' });
  });

  it('does not activate an anchor without href', async () => {
    html('<a id="a">Not a link</a>');
    const trace: string[] = [];
    recordTypes(['click'], trace);
    const outcome = await makeActions().press(
      press('Enter', { implicitSubmit: true }),
      undefined,
      byId('a')
    );
    expect(outcome).toEqual({ kind: 'press', defaultPrevented: false, defaultAction: 'none' });
    expect(trace).toEqual([]);
  });

  it('activates a link on Enter but not on Space', async () => {
    html('<a id="l" href="#next">Next</a>');
    const trace: string[] = [];
    recordTypes(['click'], trace);
    await makeActions().press(press('Enter', { implicitSubmit: true }), undefined, byId('l'));
    expect(trace).toEqual(['click@l']);
    const outcome = await makeActions().press(
      press(' ', { implicitSubmit: true }),
      undefined,
      byId('l')
    );
    expect(trace).toEqual(['click@l']);
    expect(outcome).toMatchObject({ defaultAction: 'none' });
  });

  it('toggles a checkbox on Space but not on Enter', async () => {
    html('<input type="checkbox" id="c">');
    await makeActions().press(press('Enter', { implicitSubmit: true }), undefined, byId('c'));
    expect(byId<HTMLInputElement>('c').checked).toBe(false);
    const outcome = await makeActions().press(
      press(' ', { implicitSubmit: true }),
      undefined,
      byId('c')
    );
    expect(byId<HTMLInputElement>('c').checked).toBe(true);
    expect(outcome).toMatchObject({ defaultAction: 'activate' });
  });

  it('captures the submit of an Enter-activated submit button', async () => {
    html('<form id="f"><input id="q"><button id="go">Go</button></form>');
    preventSubmits();
    const outcome = await makeActions().press(
      press('Enter', { implicitSubmit: true }),
      undefined,
      byId('go')
    );
    expect(outcome).toEqual({
      kind: 'press',
      defaultPrevented: false,
      defaultAction: 'activate',
      submit: { event: true, invalidControls: 0, defaultPrevented: true },
    });
  });

  it('activates a submit input on Enter', async () => {
    html('<form id="f"><input id="go" type="submit" value="Go"></form>');
    preventSubmits();
    const outcome = await makeActions().press(
      press('Enter', { implicitSubmit: true }),
      undefined,
      byId('go')
    );
    expect(outcome).toMatchObject({ defaultAction: 'activate', submit: { event: true } });
  });

  it('runs no default action when implicitSubmit is off, for a different key, or for a role=button div', async () => {
    html('<button id="b">Go</button><div id="d" role="button" tabindex="0"></div>');
    const trace: string[] = [];
    recordTypes(['click'], trace);
    await makeActions().press(press('Enter'), undefined, byId('b'));
    await makeActions().press(press('ArrowDown', { implicitSubmit: true }), undefined, byId('b'));
    await makeActions().press(press('Enter', { implicitSubmit: true }), undefined, byId('d'));
    expect(trace).toEqual([]);
  });

  it('does not activate when the page cancels keydown', async () => {
    html('<button id="b">Go</button>');
    byId('b').addEventListener('keydown', event => event.preventDefault());
    const trace: string[] = [];
    recordTypes(['click'], trace);
    const outcome = await makeActions().press(
      press('Enter', { implicitSubmit: true }),
      undefined,
      byId('b')
    );
    expect(trace).toEqual([]);
    expect(outcome).toMatchObject({ defaultPrevented: true, defaultAction: 'none' });
  });
});

describe('press: guard', () => {
  it('commits once, immediately before the first key event', async () => {
    html('<input id="t">');
    const trace: string[] = [];
    recordTypes(['keydown', 'keypress', 'keyup'], trace);
    await makeActions().press(press('a'), tracedGuard(trace), byId('t'));
    expect(trace).toEqual(['commit', 'keydown@t', 'keypress@t', 'keyup@t']);
  });

  it('rejects EXECUTION_CANCELLED for an aborted signal before any key event', async () => {
    html('<input id="t">');
    const samples: KeySample[] = [];
    recordKeys(samples);
    const guard = createMutationGuard(abortedSignal());
    expect(await codeOf(makeActions().press(press('a'), guard, byId('t')))).toBe(
      'EXECUTION_CANCELLED'
    );
    expect(samples).toEqual([]);
    expect(guard.committed).toBe(false);
  });

  it('moves no focus and fires no focus event when the guard refuses the commit', () => {
    html('<input id="a"><input id="b">');
    byId('a').focus();
    const trace: string[] = [];
    recordTypes(['focus', 'blur', 'keydown'], trace);
    const refusing: MutationGuard = {
      committed: false,
      checkpoint: (): void => undefined,
      commit: (): void => {
        throw new AutomationError('refused', 'EXECUTION_CANCELLED');
      },
    };
    expect(pressStrict(byId('b'), 'x', true, refusing)).toMatchObject({
      ok: false,
      code: 'EXECUTION_CANCELLED',
    });
    expect(document.activeElement).toBe(byId('a'));
    expect(trace).toEqual([]);
  });

  it('focuses the target only after the commit, before the first key event', async () => {
    html('<input id="a"><input id="b">');
    byId('a').focus();
    const trace: string[] = [];
    recordTypes(['focus', 'keydown'], trace);
    await makeActions().press(press('x'), tracedGuard(trace), byId('b'));
    expect(trace).toEqual(['commit', 'focus@b', 'keydown@b']);
  });

  it('pressStrict returns unions and never throws', () => {
    html('<input id="t">');
    expect(pressStrict(byId('t'), 'Foo', false, createMutationGuard())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
    expect(pressStrict(byId('t'), 'a', false, createMutationGuard(abortedSignal()))).toMatchObject({
      ok: false,
      code: 'EXECUTION_CANCELLED',
    });
    expect(pressStrict(byId('t'), 'Escape', false, createMutationGuard())).toEqual({
      ok: true,
      outcome: { kind: 'press', defaultPrevented: false, defaultAction: 'none' },
    });
  });
});

describe('legacy press keeps working beside strict mode', () => {
  it('commits before the first legacy key event and honors an abort during the focus wait', async () => {
    html('<input id="q" name="q">');
    const trace: string[] = [];
    recordTypes(['keydown', 'keypress', 'keyup'], trace);
    await makeActions().press(press('Enter', { selector: '#q' }), tracedGuard(trace));
    expect(trace).toEqual(['commit', 'keydown@q', 'keypress@q', 'keyup@q']);

    const after: string[] = [];
    recordTypes(['keydown'], after);
    const controller = new AbortController();
    const guard = createMutationGuard(controller.signal);
    const run = makeActions().press(press('Enter', { selector: '#q' }), guard);
    setTimeout(() => controller.abort(), 20);
    expect(await codeOf(run)).toBe('EXECUTION_CANCELLED');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(after).toEqual([]);
    expect(guard.committed).toBe(false);
  });
});

describe('canImplicitlySubmit truth table', () => {
  function check(markup: string, id = 't'): boolean {
    html(markup);
    return canImplicitlySubmit(byId(id));
  }

  it.each(['text', 'search', 'url', 'tel', 'email', 'password', 'number'])(
    'is true for an input of type %s with an enabled default button',
    type => {
      expect(check(`<form><input id="t" type="${type}"><button>Go</button></form>`)).toBe(true);
    }
  );

  it.each(['date', 'month', 'week', 'time', 'datetime-local'])(
    'treats type %s as a field that blocks implicit submission',
    type => {
      expect(check(`<form><input id="t" type="${type}"><button>Go</button></form>`)).toBe(true);
      expect(check(`<form><input id="t" type="${type}"><input type="text"></form>`)).toBe(false);
      expect(check(`<form><input id="t" type="text"><input type="${type}"></form>`)).toBe(false);
      expect(check(`<form><input id="t" type="${type}"></form>`)).toBe(true);
    }
  );

  it('is true for an input without a type attribute', () => {
    expect(check('<form><input id="t"><button>Go</button></form>')).toBe(true);
  });

  it('accepts input[type=submit] and input[type=image] as the default button', () => {
    expect(check('<form><input id="t"><input type="submit"></form>')).toBe(true);
    expect(check('<form><input id="t"><input type="image" alt="go"></form>')).toBe(true);
  });

  it('is false for a disabled default button, and judges only the FIRST submit button', () => {
    expect(check('<form><input id="t"><button disabled>Go</button></form>')).toBe(false);
    expect(
      check('<form><input id="t"><button disabled>One</button><button>Two</button></form>')
    ).toBe(false);
    expect(
      check('<form><input id="t"><button>One</button><button disabled>Two</button></form>')
    ).toBe(true);
  });

  it('ignores type=button and type=reset buttons when looking for the default button', () => {
    expect(
      check(
        '<form><input id="t"><input id="u"><button type="button">x</button><button type="reset">y</button></form>'
      )
    ).toBe(false);
    expect(
      check(
        '<form><input id="t"><button type="button">x</button><button type="reset">y</button></form>'
      )
    ).toBe(true);
  });

  it('without a submit button, requires exactly one field that blocks implicit submission', () => {
    expect(check('<form><input id="t"></form>')).toBe(true);
    expect(check('<form><input id="t"><input></form>')).toBe(false);
    expect(check('<form><input id="t"><input type="checkbox"></form>')).toBe(true);
    expect(check('<form><input id="t"><input type="hidden"></form>')).toBe(true);
    expect(check('<form><input id="t"><textarea></textarea></form>')).toBe(true);
  });

  it('is false without a form', () => {
    expect(check('<input id="t">')).toBe(false);
  });

  it('follows the form attribute of an input outside the form element', () => {
    html('<form id="f"><button>Go</button></form><input id="t" form="f">');
    expect(canImplicitlySubmit(byId('t'))).toBe(true);
  });

  it('counts a submit button that lives outside the form through its form attribute', () => {
    html('<form id="f"><input id="t"><input></form><button form="f">Go</button>');
    expect(canImplicitlySubmit(byId('t'))).toBe(true);
  });

  it.each([
    ['textarea', '<form><textarea id="t"></textarea><button>Go</button></form>'],
    ['button', '<form><button id="t">Go</button></form>'],
    ['select', '<form><select id="t"><option>a</option></select><button>Go</button></form>'],
    ['checkbox', '<form><input id="t" type="checkbox"><button>Go</button></form>'],
    ['radio', '<form><input id="t" type="radio"><button>Go</button></form>'],
    ['hidden', '<form><input id="t" type="hidden"><button>Go</button></form>'],
    ['file', '<form><input id="t" type="file"><button>Go</button></form>'],
    ['submit input', '<form><input id="t" type="submit"></form>'],
    ['div', '<form><div id="t"></div><button>Go</button></form>'],
    ['disabled input', '<form><input id="t" disabled><button>Go</button></form>'],
  ])('is false for a %s', (_label, markup) => {
    expect(check(markup)).toBe(false);
  });

  it('is true for a read-only input', () => {
    expect(check('<form><input id="t" readonly><button>Go</button></form>')).toBe(true);
  });

  it('judges a form inside a shadow root by the controls of that shadow root', () => {
    const two = mountShadow('<form><input id="t" type="text"><input type="text"></form>');
    expect(canImplicitlySubmit(inShadow(two, 't'))).toBe(false);
    const single = mountShadow('<form><input id="t" type="text"></form>');
    expect(canImplicitlySubmit(inShadow(single, 't'))).toBe(true);
    const disabled = mountShadow(
      '<form><input id="t" type="text"><button disabled>Go</button></form>'
    );
    expect(canImplicitlySubmit(inShadow(disabled, 't'))).toBe(false);
    const enabled = mountShadow(
      '<form><input id="t" type="text"><input type="text"><button>Go</button></form>'
    );
    expect(canImplicitlySubmit(inShadow(enabled, 't'))).toBe(true);
  });

  it('is pure: no event, no submission, no attribute change', () => {
    html(FORM_WITH_BUTTON);
    preventSubmits();
    const trace: string[] = [];
    recordTypes(['submit', 'click', 'focus', 'input'], trace);
    const requestSubmit = jest.spyOn(byId<HTMLFormElement>('f'), 'requestSubmit');
    const before = document.body.innerHTML;
    expect(canImplicitlySubmit(byId('q'))).toBe(true);
    expect(canImplicitlySubmit(byId('q'))).toBe(true);
    expect(trace).toEqual([]);
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(document.body.innerHTML).toBe(before);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('press: runtime type safety', () => {
  it.each([undefined, null, 13])(
    'rejects the non-string key %p without sending an event',
    async key => {
      html('<input id="t">');
      const samples: KeySample[] = [];
      recordKeys(samples);
      const code = await codeOf(
        makeActions().press({ key: key as unknown as string }, undefined, byId('t'))
      );
      expect(code).toBe('VALIDATION_FAILED');
      expect(samples).toEqual([]);
    }
  );
});
