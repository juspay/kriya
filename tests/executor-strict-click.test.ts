import { DOMActions } from '@/actions/DOMActions';
import { createMutationGuard } from '@/actions/guard';
import { clickStrict } from '@/actions/strict';
import type { ClickOptions, ErrorCode, MutationGuard } from '@/types';
import { AutomationError, DEFAULT_CONFIG } from '@/types';
import { installLayoutStubs, mountHtml, resetDom, setBox } from './helpers/domHarness';

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

function clickOptions(overrides: Partial<ClickOptions> = {}): ClickOptions {
  return { button: 'left', clickCount: 1, ...overrides };
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

function record(element: EventTarget, types: readonly string[], trace: string[]): void {
  for (const type of types) {
    element.addEventListener(type, () => trace.push(type));
  }
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

const MOUSE_SEQUENCE = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];

beforeEach(() => {
  resetDom();
  installLayoutStubs();
});

afterEach(() => {
  jest.restoreAllMocks();
  resetDom();
});

describe('strict click: exactly one activation', () => {
  it('dispatches pointerdown, mousedown, pointerup, mouseup and one click, in order, after the commit', async () => {
    mountHtml('<button id="b">Pay</button>');
    const trace: string[] = [];
    record(byId('b'), MOUSE_SEQUENCE, trace);
    const guard = tracedGuard(trace);
    const outcome = await makeActions().click(
      clickOptions({ selector: '#b', strict: true }),
      guard
    );
    expect(trace).toEqual(['commit', ...MOUSE_SEQUENCE]);
    expect(outcome).toEqual({ kind: 'click', defaultPrevented: false });
  });

  it('dispatches every event of the activation bubbling, cancelable and composed, at the element center', async () => {
    mountHtml('<button id="b">Pay</button>');
    setBox(byId('b'), { top: 100, left: 20, width: 80, height: 40 });
    const samples: { type: string; flags: boolean[]; x: number; y: number }[] = [];
    for (const type of MOUSE_SEQUENCE) {
      byId('b').addEventListener(type, event => {
        const mouse = event as MouseEvent;
        samples.push({
          type,
          flags: [event.bubbles, event.cancelable, event.composed],
          x: mouse.clientX,
          y: mouse.clientY,
        });
      });
    }
    await makeActions().click(clickOptions(), undefined, byId('b'));
    expect(samples.map(sample => sample.type)).toEqual(MOUSE_SEQUENCE);
    for (const sample of samples) {
      expect(sample).toMatchObject({ flags: [true, true, true], x: 60, y: 120 });
    }
  });

  it('commits once and never between the events of the activation', async () => {
    mountHtml('<button id="b">Pay</button>');
    const trace: string[] = [];
    record(byId('b'), MOUSE_SEQUENCE, trace);
    await makeActions().click(clickOptions(), tracedGuard(trace), byId('b'));
    expect(trace.filter(entry => entry === 'commit')).toHaveLength(1);
    expect(trace[0]).toBe('commit');
  });

  it('stays at a single dispatch when the handler calls preventDefault (legacy dispatched twice)', async () => {
    mountHtml('<button id="b">Buy</button>');
    const clicks: Event[] = [];
    byId('b').addEventListener('click', event => {
      clicks.push(event);
      event.preventDefault();
    });
    const nativeClick = jest.spyOn(HTMLElement.prototype, 'click');
    const outcome = await makeActions().click(clickOptions(), undefined, byId('b'));
    expect(clicks).toHaveLength(1);
    expect(nativeClick).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'click', defaultPrevented: true });
  });

  it('ignores clickCount, button and position: one left click at the element center', async () => {
    mountHtml('<button id="b">Pay</button>');
    const clicks: MouseEvent[] = [];
    byId('b').addEventListener('click', event => clicks.push(event));
    await makeActions().click(
      clickOptions({ clickCount: 3, button: 'right', position: { x: 1, y: 1 } }),
      undefined,
      byId('b')
    );
    expect(clicks).toHaveLength(1);
    const [click] = clicks;
    expect(click?.button).toBe(0);
    expect(click?.detail).toBe(1);
    const rect = byId('b').getBoundingClientRect();
    expect(click?.clientX).toBe(rect.left + rect.width / 2);
    expect(click?.clientY).toBe(rect.top + rect.height / 2);
    expect(click?.bubbles).toBe(true);
    expect(click?.cancelable).toBe(true);
  });

  it('never calls window.open and never simulates Enter on a _blank link', async () => {
    mountHtml('<a id="l" href="https://example.test/next" target="_blank">Next</a>');
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    const trace: string[] = [];
    record(byId('l'), ['click', 'keydown', 'keyup', 'keypress'], trace);
    byId('l').addEventListener('click', event => event.preventDefault());
    await makeActions().click(clickOptions(), undefined, byId('l'));
    expect(open).not.toHaveBeenCalled();
    expect(trace).toEqual(['click']);
  });

  it('does not schedule any timer-based follow-up', async () => {
    mountHtml('<a id="l" href="https://example.test/next">Next</a>');
    byId('l').addEventListener('click', event => event.preventDefault());
    const timers = jest.spyOn(globalThis, 'setTimeout');
    await makeActions().click(clickOptions(), undefined, byId('l'));
    expect(timers).not.toHaveBeenCalled();
  });

  it('clicks the element itself instead of a clickable child (no legacy retargeting)', async () => {
    mountHtml('<div id="card"><button id="inner">Inner</button></div>');
    setBox(byId('card'), { top: 100, height: 100 });
    setBox(byId('inner'), { top: 100, height: 20 });
    const hits: string[] = [];
    byId('card').addEventListener('click', event =>
      hits.push(`card<-${(event.target as HTMLElement).id}`)
    );
    byId('inner').addEventListener('click', () => hits.push('inner'));
    await makeActions().click(clickOptions(), undefined, byId('card'));
    expect(hits).toEqual(['card<-card']);
  });

  it('toggles a checkbox that sits inside a pointer-cursor card (legacy clicked the card)', async () => {
    mountHtml('<div id="card" style="cursor:pointer"><input type="checkbox" id="c"></div>');
    setBox(byId('card'), { top: 200, height: 60 });
    const card: string[] = [];
    byId('card').addEventListener('click', () => card.push('card'));
    await makeActions().click(clickOptions(), undefined, byId('c'));
    expect(byId<HTMLInputElement>('c').checked).toBe(true);
    expect(card).toEqual(['card']);
  });
});

describe('strict click: target resolution', () => {
  it('resolves a CSS selector to exactly one element', async () => {
    mountHtml('<button id="a">A</button><button id="b">B</button>');
    const hits: string[] = [];
    byId('a').addEventListener('click', () => hits.push('a'));
    byId('b').addEventListener('click', () => hits.push('b'));
    await makeActions().click(clickOptions({ selector: '#b', strict: true }));
    expect(hits).toEqual(['b']);
  });

  it('uses the passed target and implies strict mode', async () => {
    mountHtml('<button id="a">A</button><button id="b">B</button>');
    const hits: string[] = [];
    byId('a').addEventListener('click', () => hits.push('a'));
    byId('b').addEventListener('click', () => hits.push('b'));
    await makeActions().click(clickOptions({ selector: '#a' }), undefined, byId('b'));
    expect(hits).toEqual(['b']);
  });

  it('rejects a stale selector with TARGET_STALE and does not fall back to fuzzy description matching', async () => {
    mountHtml('<button id="del">Delete account</button>');
    const hits: string[] = [];
    byId('del').addEventListener('click', () => hits.push('del'));
    const guard = createMutationGuard();
    const code = await codeOf(
      makeActions().click(
        clickOptions({ selector: '#gone', description: 'Delete', strict: true }),
        guard
      )
    );
    expect(code).toBe('TARGET_STALE');
    expect(hits).toEqual([]);
    expect(guard.committed).toBe(false);
  });

  it('rejects an ambiguous selector with TARGET_AMBIGUOUS', async () => {
    mountHtml('<button class="x">A</button><button class="x">B</button>');
    const hits: string[] = [];
    document.addEventListener('click', () => hits.push('click'), true);
    const code = await codeOf(makeActions().click(clickOptions({ selector: '.x', strict: true })));
    expect(code).toBe('TARGET_AMBIGUOUS');
    expect(hits).toEqual([]);
  });

  it('rejects a detached target with TARGET_STALE', async () => {
    mountHtml('<button id="b">B</button>');
    const detached = byId('b');
    detached.remove();
    const hits: string[] = [];
    detached.addEventListener('click', () => hits.push('click'));
    const code = await codeOf(makeActions().click(clickOptions(), undefined, detached));
    expect(code).toBe('TARGET_STALE');
    expect(hits).toEqual([]);
  });

  it('rejects an invalid selector with VALIDATION_FAILED', async () => {
    mountHtml('<button id="b">B</button>');
    const code = await codeOf(
      makeActions().click(clickOptions({ selector: '##[x', strict: true }))
    );
    expect(code).toBe('VALIDATION_FAILED');
  });

  it('fails INVALID_ACTION with no commit and no click when strict has neither target nor selector', async () => {
    mountHtml('<button id="b">Pay now</button>');
    const hits: string[] = [];
    byId('b').addEventListener('click', () => hits.push('click'));
    const guard = createMutationGuard();
    const error = await failureOf(
      makeActions().click(clickOptions({ description: 'Pay now', strict: true }), guard)
    );
    expect(error.code).toBe('INVALID_ACTION');
    expect(hits).toEqual([]);
    expect(guard.committed).toBe(false);
    expect(error.message).not.toContain('Pay now');
  });
});

describe('strict click: scroll before measure, visibility and hit test', () => {
  it('scrolls the element into view before it measures geometry', async () => {
    mountHtml('<button id="b">Far</button>');
    setBox(byId('b'), { top: 2000 });
    const scroll = jest.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
      this: Element
    ) {
      setBox(this as HTMLElement, { top: 300 });
    });
    const hits: string[] = [];
    byId('b').addEventListener('click', () => hits.push('click'));
    await makeActions().click(clickOptions(), undefined, byId('b'));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith(
      expect.objectContaining({ block: 'center', behavior: 'instant' })
    );
    expect(hits).toEqual(['click']);
  });

  it('rejects an element that stays off screen after scrolling as TARGET_OBSCURED', async () => {
    mountHtml('<button id="b">Far</button>');
    setBox(byId('b'), { top: 5000 });
    const hits: string[] = [];
    byId('b').addEventListener('click', () => hits.push('click'));
    const code = await codeOf(makeActions().click(clickOptions(), undefined, byId('b')));
    expect(code).toBe('TARGET_OBSCURED');
    expect(hits).toEqual([]);
  });

  it('rejects a target covered by an overlay without clicking through it', async () => {
    mountHtml('<button id="b">Pay</button><div id="cover"></div>');
    setBox(byId('b'), { top: 100 });
    setBox(byId('cover'), { top: 90, height: 60, width: 200 });
    const hits: string[] = [];
    byId('b').addEventListener('click', () => hits.push('b'));
    byId('cover').addEventListener('click', () => hits.push('cover'));
    const guard = createMutationGuard();
    const code = await codeOf(makeActions().click(clickOptions(), guard, byId('b')));
    expect(code).toBe('TARGET_OBSCURED');
    expect(hits).toEqual([]);
    expect(guard.committed).toBe(false);
  });

  it('accepts a target whose center is covered by its own descendant', async () => {
    mountHtml('<button id="b"><span id="s">Pay</span></button>');
    setBox(byId('b'), { top: 100 });
    setBox(byId('s'), { top: 100 });
    const hits: string[] = [];
    byId('b').addEventListener('click', () => hits.push('b'));
    await makeActions().click(clickOptions(), undefined, byId('b'));
    expect(hits).toEqual(['b']);
  });

  it('accepts a target whose overlay lets pointer events through', async () => {
    mountHtml('<button id="b">Pay</button><div id="cover" style="pointer-events:none"></div>');
    setBox(byId('b'), { top: 100 });
    setBox(byId('cover'), { top: 90, height: 60, width: 200 });
    const hits: string[] = [];
    byId('b').addEventListener('click', () => hits.push('b'));
    await makeActions().click(clickOptions(), undefined, byId('b'));
    expect(hits).toEqual(['b']);
  });

  it('rejects a target with pointer-events:none, which a real click could not reach', async () => {
    mountHtml('<button id="b" style="pointer-events:none">Pay</button>');
    const code = await codeOf(makeActions().click(clickOptions(), undefined, byId('b')));
    expect(code).toBe('TARGET_OBSCURED');
  });

  it('rejects visibility:hidden and display:none targets', async () => {
    mountHtml(
      '<button id="v" style="visibility:hidden">V</button><button id="d" style="display:none">D</button>'
    );
    expect(await codeOf(makeActions().click(clickOptions(), undefined, byId('v')))).toBe(
      'TARGET_OBSCURED'
    );
    expect(await codeOf(makeActions().click(clickOptions(), undefined, byId('d')))).toBe(
      'TARGET_OBSCURED'
    );
  });

  it('rejects an element that has no box at all', async () => {
    document.body.innerHTML = '<button id="b">No layout</button>';
    const code = await codeOf(makeActions().click(clickOptions(), undefined, byId('b')));
    expect(code).toBe('TARGET_OBSCURED');
  });

  it('rejects a box that is wide but has no height, even without a hit test', async () => {
    mountHtml('<button id="b">Flat</button>');
    setBox(byId('b'), { top: 100, width: 120, height: 0 });
    Reflect.deleteProperty(document, 'elementFromPoint');
    const hits: string[] = [];
    byId('b').addEventListener('click', () => hits.push('click'));
    expect(await codeOf(makeActions().click(clickOptions(), undefined, byId('b')))).toBe(
      'TARGET_OBSCURED'
    );
    setBox(byId('b'), { top: 100, width: 0, height: 30 });
    expect(await codeOf(makeActions().click(clickOptions(), undefined, byId('b')))).toBe(
      'TARGET_OBSCURED'
    );
    expect(hits).toEqual([]);
  });

  it('skips the hit test when the environment has no elementFromPoint', async () => {
    mountHtml('<button id="b">Pay</button>');
    Reflect.deleteProperty(document, 'elementFromPoint');
    const hits: string[] = [];
    byId('b').addEventListener('click', () => hits.push('b'));
    await makeActions().click(clickOptions(), undefined, byId('b'));
    expect(hits).toEqual(['b']);
  });
});

describe('strict click: disabled targets', () => {
  it.each([
    ['disabled button', '<button id="t" disabled>Go</button>'],
    ['disabled submit input', '<form><input id="t" type="submit" disabled></form>'],
    ['disabled fieldset', '<fieldset disabled><button id="t">Go</button></fieldset>'],
    ['aria-disabled', '<button id="t" aria-disabled="true">Go</button>'],
    ['aria-disabled link', '<a id="t" href="#x" aria-disabled="true">Go</a>'],
  ])('rejects a %s with TARGET_DISABLED and never delivers the click', async (_label, markup) => {
    mountHtml(markup);
    const hits: string[] = [];
    document.addEventListener('click', () => hits.push('click'), true);
    const guard = createMutationGuard();
    const code = await codeOf(makeActions().click(clickOptions(), guard, byId('t')));
    expect(code).toBe('TARGET_DISABLED');
    expect(hits).toEqual([]);
    expect(guard.committed).toBe(false);
  });
});

describe('strict click: submit capture', () => {
  it('reports a validation-blocked submit: no submit event, one invalid control', async () => {
    mountHtml(
      '<form id="f"><input id="name" required><input id="mail" required><button id="go">Go</button></form>'
    );
    const submits: string[] = [];
    byId('f').addEventListener('submit', () => submits.push('submit'));
    const outcome = await makeActions().click(clickOptions(), undefined, byId('go'));
    expect(submits).toEqual([]);
    expect(outcome).toEqual({
      kind: 'click',
      defaultPrevented: false,
      submit: { event: false, invalidControls: 2, defaultPrevented: false },
    });
  });

  it('reports a submit event that the page handles with preventDefault', async () => {
    mountHtml(
      '<form id="f"><input id="name" required value="x"><button id="go">Go</button></form>'
    );
    byId('f').addEventListener('submit', event => event.preventDefault());
    const outcome = await makeActions().click(clickOptions(), undefined, byId('go'));
    expect(outcome).toEqual({
      kind: 'click',
      defaultPrevented: false,
      submit: { event: true, invalidControls: 0, defaultPrevented: true },
    });
  });

  it('reports submit.defaultPrevented false when nothing handled the submit', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mountHtml('<form id="f"><input id="name" value="x"><button id="go">Go</button></form>');
    const outcome = await makeActions().click(clickOptions(), undefined, byId('go'));
    expect(outcome).toMatchObject({
      submit: { event: true, invalidControls: 0, defaultPrevented: false },
    });
  });

  it('captures a submit input as well as a button', async () => {
    mountHtml('<form id="f"><input id="go" type="submit" value="Go"></form>');
    byId('f').addEventListener('submit', event => event.preventDefault());
    const outcome = await makeActions().click(clickOptions(), undefined, byId('go'));
    expect(outcome).toMatchObject({ submit: { event: true } });
  });

  it('adds no submit info for a type=button control inside a form', async () => {
    mountHtml('<form id="f"><button id="b" type="button">Open</button></form>');
    const submits: string[] = [];
    byId('f').addEventListener('submit', () => submits.push('submit'));
    const outcome = await makeActions().click(clickOptions(), undefined, byId('b'));
    expect(outcome).toEqual({ kind: 'click', defaultPrevented: false });
    expect(submits).toEqual([]);
  });

  it('adds no submit info for a button outside every form or a link', async () => {
    mountHtml('<button id="b">Open</button><a id="l" href="#x">Link</a>');
    expect(await makeActions().click(clickOptions(), undefined, byId('b'))).toEqual({
      kind: 'click',
      defaultPrevented: false,
    });
    expect(await makeActions().click(clickOptions(), undefined, byId('l'))).toEqual({
      kind: 'click',
      defaultPrevented: false,
    });
  });

  it('counts only invalid controls of the submitting form', async () => {
    mountHtml(
      '<form id="a"><button id="go">Go</button></form><form id="b"><input id="req" required></form>'
    );
    byId('a').addEventListener('submit', event => event.preventDefault());
    byId('go').addEventListener('click', () => {
      byId<HTMLFormElement>('b').reportValidity();
    });
    const outcome = await makeActions().click(clickOptions(), undefined, byId('go'));
    expect(outcome).toMatchObject({ submit: { event: true, invalidControls: 0 } });
  });

  describe('for a form inside a shadow root (submit and invalid are not composed)', () => {
    function mountShadowForm(markup: string): { form: HTMLFormElement; go: HTMLElement } {
      const host = document.createElement('div');
      document.body.append(host);
      setBox(host, { top: 10 });
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = markup;
      const go = root.getElementById('go');
      const form = root.getElementById('f');
      if (go === null || form === null) {
        throw new Error('fixture is missing the shadow form');
      }
      for (const control of root.querySelectorAll('input, button')) {
        setBox(control, { top: 10 });
      }
      // jsdom has no ShadowRoot.elementFromPoint; a browser reports the topmost element of that tree.
      Object.defineProperty(root, 'elementFromPoint', { value: (): Element => go });
      return { form: form as HTMLFormElement, go };
    }

    it('reports the submit event that the shadow form handled with preventDefault', async () => {
      const { form, go } = mountShadowForm(
        '<form id="f"><input required value="x"><button id="go">Go</button></form>'
      );
      form.addEventListener('submit', event => event.preventDefault());
      expect(await makeActions().click(clickOptions(), undefined, go)).toEqual({
        kind: 'click',
        defaultPrevented: false,
        submit: { event: true, invalidControls: 0, defaultPrevented: true },
      });
    });

    it('counts the invalid controls that blocked the submission of a shadow form', async () => {
      const { go } = mountShadowForm(
        '<form id="f"><input required><input required><button id="go">Go</button></form>'
      );
      expect(await makeActions().click(clickOptions(), undefined, go)).toEqual({
        kind: 'click',
        defaultPrevented: false,
        submit: { event: false, invalidControls: 2, defaultPrevented: false },
      });
    });
  });

  it('ignores the submit event of another form that the click handler triggers', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mountHtml(
      '<form id="c"><button id="send">Send</button></form><form id="d"><input value="y"></form>'
    );
    byId('d').addEventListener('submit', event => event.preventDefault());
    byId('send').addEventListener('click', () => {
      byId<HTMLFormElement>('d').requestSubmit();
    });
    const outcome = await makeActions().click(clickOptions(), undefined, byId('send'));
    expect(outcome).toEqual({
      kind: 'click',
      defaultPrevented: false,
      submit: { event: true, invalidControls: 0, defaultPrevented: false },
    });
  });

  it('adds no submit info when the clicked control is not a submit control, whatever else submits', async () => {
    mountHtml(
      '<form id="a"><button id="go" type="button">Go</button></form><form id="b"><input value="x"></form>'
    );
    byId('b').addEventListener('submit', event => event.preventDefault());
    byId('go').addEventListener('click', () => {
      byId<HTMLFormElement>('b').requestSubmit();
    });
    const outcome = await makeActions().click(clickOptions(), undefined, byId('go'));
    expect(outcome).toEqual({ kind: 'click', defaultPrevented: false });
  });

  it('removes every capture listener it added', async () => {
    mountHtml('<form id="f"><input id="name" required><button id="go">Go</button></form>');
    const added = jest.spyOn(EventTarget.prototype, 'addEventListener');
    const removed = jest.spyOn(EventTarget.prototype, 'removeEventListener');
    await makeActions().click(clickOptions(), undefined, byId('go'));
    const tally = (calls: readonly (readonly unknown[])[], type: string): number =>
      calls.filter(call => call[0] === type).length;
    for (const type of ['submit', 'invalid']) {
      expect(tally(added.mock.calls, type)).toBeGreaterThan(0);
      expect(tally(removed.mock.calls, type)).toBe(tally(added.mock.calls, type));
    }
  });

  it('removes the capture listeners even when the page handler throws', async () => {
    mountHtml('<form id="f"><button id="go">Go</button></form>');
    byId('f').addEventListener('submit', event => event.preventDefault());
    byId('go').addEventListener('click', () => {
      throw new Error('page handler failed');
    });
    const added = jest.spyOn(EventTarget.prototype, 'addEventListener');
    const removed = jest.spyOn(EventTarget.prototype, 'removeEventListener');
    const reported: string[] = [];
    const onError = (event: ErrorEvent): void => {
      reported.push(event.message);
      event.preventDefault();
    };
    window.addEventListener('error', onError);
    try {
      const outcome = await makeActions().click(clickOptions(), undefined, byId('go'));
      expect(outcome).toMatchObject({ kind: 'click' });
    } finally {
      window.removeEventListener('error', onError);
    }
    expect(reported).toHaveLength(1);
    expect(removed.mock.calls.filter(call => call[0] === 'submit')).toHaveLength(
      added.mock.calls.filter(call => call[0] === 'submit').length
    );
  });
});

describe('strict click: guard and outcome', () => {
  it('does not even scroll the target into view once the signal is aborted', async () => {
    mountHtml('<button id="b">Pay</button>');
    const scroll = jest.spyOn(Element.prototype, 'scrollIntoView');
    const hits: string[] = [];
    byId('b').addEventListener('click', () => hits.push('click'));
    const guard = createMutationGuard(abortedSignal());
    expect(await codeOf(makeActions().click(clickOptions(), guard, byId('b')))).toBe(
      'EXECUTION_CANCELLED'
    );
    const direct = clickStrict(byId('b'), guard);
    expect(direct).toMatchObject({ ok: false, code: 'EXECUTION_CANCELLED' });
    expect(scroll).not.toHaveBeenCalled();
    expect(hits).toEqual([]);
  });

  it('rejects EXECUTION_CANCELLED for an aborted signal before any event is dispatched', async () => {
    mountHtml('<button id="b">B</button>');
    const trace: string[] = [];
    record(byId('b'), MOUSE_SEQUENCE, trace);
    const guard = createMutationGuard(abortedSignal());
    const code = await codeOf(makeActions().click(clickOptions(), guard, byId('b')));
    expect(code).toBe('EXECUTION_CANCELLED');
    expect(trace).toEqual([]);
    expect(guard.committed).toBe(false);
  });

  it('survives a JSON round trip and carries only booleans and counts', async () => {
    mountHtml('<form id="f"><input id="n" required><button id="go">Go</button></form>');
    const outcome = await makeActions().click(clickOptions(), undefined, byId('go'));
    expect(JSON.parse(JSON.stringify(outcome))).toEqual(outcome);
  });

  it('clickStrict maps a throwing guard and an obscured target to failure results', () => {
    mountHtml('<button id="b">B</button><div id="cover"></div>');
    setBox(byId('cover'), { top: 0, height: 700, width: 700 });
    const obscured = clickStrict(byId('b'), createMutationGuard());
    expect(obscured).toMatchObject({ ok: false, code: 'TARGET_OBSCURED' });

    byId('cover').remove();
    setBox(byId('b'), { top: 100 });
    const cancelled = clickStrict(byId('b'), createMutationGuard(abortedSignal()));
    expect(cancelled).toMatchObject({ ok: false, code: 'EXECUTION_CANCELLED' });

    const clicked = clickStrict(byId('b'), createMutationGuard());
    expect(clicked).toEqual({ ok: true, outcome: { kind: 'click', defaultPrevented: false } });
  });
});

describe('legacy click keeps working beside strict mode', () => {
  it('still finds a button by description text and returns no outcome', async () => {
    mountHtml('<button id="pay">Pay now</button>');
    const hits: string[] = [];
    byId('pay').addEventListener('click', () => hits.push('click'));
    const result = await makeActions().click(clickOptions({ description: 'Pay now' }));
    expect(hits).toEqual(['click']);
    expect(result).toBeUndefined();
  });

  it('commits right before the first dispatch of the legacy activation', async () => {
    mountHtml('<button id="pay">Pay now</button>');
    const trace: string[] = [];
    record(byId('pay'), ['mousedown', 'mouseup', 'click'], trace);
    await makeActions().click(clickOptions({ description: 'Pay now' }), tracedGuard(trace));
    expect(trace).toEqual(['commit', 'mousedown', 'mouseup', 'click']);
  });

  it('does not click after the signal aborts during the legacy scroll wait', async () => {
    mountHtml('<button id="pay">Pay now</button>');
    const hits: string[] = [];
    byId('pay').addEventListener('click', () => hits.push('click'));
    const controller = new AbortController();
    const guard = createMutationGuard(controller.signal);
    const run = makeActions().click(clickOptions({ description: 'Pay now' }), guard);
    setTimeout(() => controller.abort(), 20);
    const code = await codeOf(run);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(code).toBe('EXECUTION_CANCELLED');
    expect(hits).toEqual([]);
    expect(guard.committed).toBe(false);
  });
});

describe('legacy navigate and wait honor the guard', () => {
  it('commits right before a navigation and leaves the location alone for an aborted guard', async () => {
    const trace: string[] = [];
    await makeActions().navigate({ url: '#done', waitForLoad: false }, tracedGuard(trace));
    expect(trace).toEqual(['commit']);
    expect(window.location.hash).toBe('#done');

    const guard = createMutationGuard(abortedSignal());
    const code = await codeOf(makeActions().navigate({ url: '#never', waitForLoad: false }, guard));
    expect(code).toBe('EXECUTION_CANCELLED');
    expect(window.location.hash).toBe('#done');
    expect(guard.committed).toBe(false);
  });

  it('removes its load listener when the navigation times out', async () => {
    const added = jest.spyOn(window, 'addEventListener');
    const removed = jest.spyOn(window, 'removeEventListener');
    await expect(
      makeActions().navigate({ url: '#slow', waitForLoad: true, timeout: 30 })
    ).rejects.toBeInstanceOf(AutomationError);
    const loads = (calls: readonly (readonly unknown[])[]): readonly unknown[] =>
      calls.filter(call => call[0] === 'load').map(call => call[1]);
    expect(loads(added.mock.calls)).toHaveLength(1);
    expect(loads(removed.mock.calls)).toEqual(loads(added.mock.calls));
  });

  it('never commits a wait and stops waiting for a condition once the signal aborts', async () => {
    const calm = createMutationGuard();
    await makeActions().wait({ duration: 20 }, calm);
    expect(calm.committed).toBe(false);

    const controller = new AbortController();
    const guard = createMutationGuard(controller.signal);
    const started = Date.now();
    const run = makeActions().wait(
      { selector: '#never-there', condition: 'visible', timeout: 2000 },
      guard
    );
    setTimeout(() => controller.abort(), 50);
    expect(await codeOf(run)).toBe('EXECUTION_CANCELLED');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(guard.committed).toBe(false);
  });

  it('rejects a timed wait with EXECUTION_CANCELLED after the signal aborts during the sleep', async () => {
    const controller = new AbortController();
    const run = makeActions().wait({ duration: 80 }, createMutationGuard(controller.signal));
    setTimeout(() => controller.abort(), 20);
    expect(await codeOf(run)).toBe('EXECUTION_CANCELLED');
  });
});
