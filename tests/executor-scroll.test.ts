import { DOMActions } from '@/actions/DOMActions';
import { createMutationGuard } from '@/actions/guard';
import { scroll } from '@/actions/strict';
import type { ErrorCode, MutationGuard, ScrollDirectionName, ScrollOptions } from '@/types';
import { AutomationError, DEFAULT_CONFIG } from '@/types';
import {
  installLayoutStubs,
  makeScrollable,
  mountHtml,
  resetDom,
  setBox,
  setViewport,
} from './helpers/domHarness';

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

function options(
  direction: ScrollDirectionName,
  overrides: Partial<ScrollOptions> = {}
): ScrollOptions {
  return { direction, ...overrides };
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

const VIEWPORT_HEIGHT = 800;
const PAGE_HEIGHT = 3000;
const PAGE_MAX = PAGE_HEIGHT - VIEWPORT_HEIGHT;
const PAGE_STEP = Math.floor(VIEWPORT_HEIGHT * 0.7);

function pageOutcome(overrides: Record<string, unknown>): Record<string, unknown> {
  return { kind: 'scroll', max: PAGE_MAX, ...overrides };
}

function makeContainer(clientHeight = 200, scrollHeight = 1000, overflow = 'auto'): HTMLElement {
  mountHtml(`<div id="list" style="overflow-y:${overflow}"></div>`);
  const element = byId('list');
  setBox(element, { top: 100, height: clientHeight });
  return makeScrollable(element, { scrollHeight, clientHeight });
}

beforeEach(() => {
  resetDom();
  installLayoutStubs();
  setViewport({ height: VIEWPORT_HEIGHT, scrollHeight: PAGE_HEIGHT });
});

afterEach(() => {
  jest.restoreAllMocks();
  Reflect.deleteProperty(document.documentElement, 'scrollTo');
  resetDom();
});

describe('scroll: window', () => {
  it('pages DOWN by 70 percent of the viewport until the clamp at the bottom', async () => {
    const actions = makeActions();
    const seen: Array<Record<string, unknown>> = [];
    for (let step = 0; step < 4; step += 1) {
      seen.push({ ...(await actions.scroll(options('DOWN'))) });
    }
    expect(seen.map(outcome => [outcome.before, outcome.after])).toEqual([
      [0, PAGE_STEP],
      [PAGE_STEP, PAGE_STEP * 2],
      [PAGE_STEP * 2, PAGE_STEP * 3],
      [PAGE_STEP * 3, PAGE_MAX],
    ]);
    expect(window.scrollY).toBe(PAGE_MAX);
    expect(seen[3]).toEqual(
      pageOutcome({
        moved: true,
        before: PAGE_STEP * 3,
        after: PAGE_MAX,
        atTop: false,
        atBottom: true,
      })
    );
  });

  it('reports the first move without a reason and with correct edge flags', async () => {
    const outcome = await makeActions().scroll(options('DOWN'));
    expect(outcome).toEqual(
      pageOutcome({ moved: true, before: 0, after: PAGE_STEP, atTop: false, atBottom: false })
    );
    expect(outcome).not.toHaveProperty('reason');
  });

  it('scrolls UP by one step, and TOP and BOTTOM jump to the ends', async () => {
    setViewport({ scrollY: 1500 });
    const actions = makeActions();
    expect(await actions.scroll(options('UP'))).toMatchObject({
      moved: true,
      before: 1500,
      after: 1500 - PAGE_STEP,
    });
    expect(await actions.scroll(options('BOTTOM'))).toMatchObject({
      moved: true,
      after: PAGE_MAX,
      atBottom: true,
    });
    expect(await actions.scroll(options('TOP'))).toMatchObject({
      moved: true,
      before: PAGE_MAX,
      after: 0,
      atTop: true,
    });
  });

  it.each(['UP', 'TOP'] as const)(
    'treats %s at the top as an edge no-op without a commit',
    async direction => {
      const trace: string[] = [];
      document.addEventListener('scroll', () => trace.push('scroll'));
      const guard = tracedGuard(trace);
      const outcome = await makeActions().scroll(options(direction), guard);
      expect(outcome).toEqual(
        pageOutcome({
          moved: false,
          reason: 'edge',
          before: 0,
          after: 0,
          atTop: true,
          atBottom: false,
        })
      );
      expect(guard.committed).toBe(false);
      expect(trace).toEqual([]);
    }
  );

  it.each(['DOWN', 'BOTTOM'] as const)(
    'treats %s at the bottom as an edge no-op without a commit',
    async direction => {
      setViewport({ scrollY: PAGE_MAX });
      const guard = createMutationGuard();
      const outcome = await makeActions().scroll(options(direction), guard);
      expect(outcome).toEqual(
        pageOutcome({
          moved: false,
          reason: 'edge',
          before: PAGE_MAX,
          after: PAGE_MAX,
          atTop: false,
          atBottom: true,
        })
      );
      expect(guard.committed).toBe(false);
    }
  );

  it('treats a sub-pixel distance as the edge, and a full pixel as a move', async () => {
    setViewport({ scrollY: 0.5 });
    expect(await makeActions().scroll(options('UP'))).toMatchObject({
      moved: false,
      reason: 'edge',
      atTop: true,
    });
    setViewport({ scrollY: PAGE_MAX - 0.5 });
    expect(await makeActions().scroll(options('BOTTOM'))).toMatchObject({
      moved: false,
      reason: 'edge',
      atBottom: true,
    });
    setViewport({ scrollY: 1 });
    expect(await makeActions().scroll(options('TOP'))).toMatchObject({ moved: true, after: 0 });
  });

  it('flags the page ends from where the scroll lands, with a 2 px tolerance', async () => {
    setViewport({ scrollY: 2 });
    expect(await makeActions().scroll(options('TOP'))).toMatchObject({
      moved: true,
      after: 0,
      atTop: true,
    });
    setViewport({ scrollY: PAGE_MAX - 2 });
    expect(await makeActions().scroll(options('DOWN'))).toMatchObject({
      moved: true,
      after: PAGE_MAX,
      atBottom: true,
    });
    setViewport({ scrollY: 1500 });
    expect(await makeActions().scroll(options('UP'))).toMatchObject({
      moved: true,
      atTop: false,
      atBottom: false,
    });
  });

  it('puts the 2 px tolerance exactly at 2 and 3 px for atTop, 798 and 797 px for atBottom', async () => {
    const container = makeContainer();
    const actions = makeActions();
    container.scrollTop = 142;
    expect(await actions.scroll(options('UP'), undefined, container)).toMatchObject({
      after: 2,
      atTop: true,
    });
    container.scrollTop = 143;
    expect(await actions.scroll(options('UP'), undefined, container)).toMatchObject({
      after: 3,
      atTop: false,
    });
    container.scrollTop = 658;
    expect(await actions.scroll(options('DOWN'), undefined, container)).toMatchObject({
      after: 798,
      atBottom: true,
    });
    container.scrollTop = 657;
    expect(await actions.scroll(options('DOWN'), undefined, container)).toMatchObject({
      after: 797,
      atBottom: false,
    });
  });

  it('moves again once an infinite page grows', async () => {
    setViewport({ scrollY: PAGE_MAX });
    const actions = makeActions();
    expect(await actions.scroll(options('DOWN'))).toMatchObject({ moved: false, reason: 'edge' });
    setViewport({ scrollHeight: PAGE_HEIGHT + 1000 });
    expect(await actions.scroll(options('DOWN'))).toMatchObject({
      moved: true,
      before: PAGE_MAX,
      max: PAGE_MAX + 1000,
    });
  });

  it('uses one instant scrollTo call, never smooth scrolling', async () => {
    const scrollTo = jest.spyOn(document.documentElement, 'scrollTo');
    await makeActions().scroll(options('DOWN'));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: PAGE_STEP, behavior: 'instant' })
    );
  });

  it('falls back to assigning scrollTop when the environment has no scrollTo', async () => {
    Object.defineProperty(document.documentElement, 'scrollTo', {
      configurable: true,
      value: undefined,
    });
    const outcome = await makeActions().scroll(options('DOWN'));
    expect(window.scrollY).toBe(PAGE_STEP);
    expect(outcome).toMatchObject({ moved: true, after: PAGE_STEP });
  });

  it('commits once, immediately before the single scroll', async () => {
    const trace: string[] = [];
    document.addEventListener('scroll', () => trace.push('scroll'));
    await makeActions().scroll(options('DOWN'), tracedGuard(trace));
    expect(trace).toEqual(['commit', 'scroll']);
  });

  it('reports a scroll that the page blocks as moved:false reason:blocked, after a commit', async () => {
    const scrollTo = jest
      .spyOn(document.documentElement, 'scrollTo')
      .mockImplementation(() => undefined);
    const guard = createMutationGuard();
    const outcome = await makeActions().scroll(options('DOWN'), guard);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual(
      pageOutcome({
        moved: false,
        reason: 'blocked',
        before: 0,
        after: 0,
        atTop: true,
        atBottom: false,
      })
    );
    expect(guard.committed).toBe(true);
  });

  it('reports a scroll that lands under one pixel from where it was as blocked, not as a move', async () => {
    jest.spyOn(document.documentElement, 'scrollTo').mockImplementation(() => {
      document.documentElement.scrollTop = 0.4;
    });
    const outcome = await makeActions().scroll(options('DOWN'));
    expect(outcome).toMatchObject({ moved: false, reason: 'blocked', before: 0 });
  });

  it('scrolls the page when neither a target nor a selector is given, even for a description', async () => {
    const outcome = await makeActions().scroll(
      options('DOWN', { description: 'results' } as never)
    );
    expect(outcome).toMatchObject({ moved: true, after: PAGE_STEP });
  });

  it('treats an empty selector string like no selector: it scrolls the page', async () => {
    const outcome = await makeActions().scroll(options('DOWN', { selector: '' }));
    expect(outcome).toMatchObject({ moved: true, after: PAGE_STEP });
    expect(window.scrollY).toBe(PAGE_STEP);
  });

  it.each(['documentElement', 'body'] as const)(
    'treats the %s as the page scroller',
    async which => {
      const root = which === 'body' ? document.body : document.documentElement;
      const outcome = await makeActions().scroll(options('DOWN'), undefined, root);
      expect(outcome).toMatchObject({ moved: true, after: PAGE_STEP });
      expect(window.scrollY).toBe(PAGE_STEP);
    }
  );

  it('carries only numbers and booleans and survives a JSON round trip', async () => {
    const outcome = await makeActions().scroll(options('DOWN'));
    expect(JSON.parse(JSON.stringify(outcome))).toEqual(outcome);
    for (const value of Object.values(outcome ?? {})) {
      expect(['number', 'boolean', 'string']).toContain(typeof value);
    }
  });
});

describe('scroll: containers', () => {
  it('keeps the horizontal position of the container it scrolls', async () => {
    const container = makeContainer();
    Object.defineProperty(container, 'scrollLeft', { configurable: true, value: 37 });
    const scrollTo = jest.fn();
    Object.defineProperty(container, 'scrollTo', { configurable: true, value: scrollTo });
    await makeActions().scroll(options('DOWN'), undefined, container);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ left: 37, behavior: 'instant' })
    );
  });

  it('scrolls a container passed as the target and leaves the window alone', async () => {
    const container = makeContainer();
    const events: string[] = [];
    container.addEventListener('scroll', () => events.push('scroll'));
    const outcome = await makeActions().scroll(options('DOWN'), undefined, container);
    expect(outcome).toEqual({
      kind: 'scroll',
      moved: true,
      before: 0,
      after: 140,
      max: 800,
      atTop: false,
      atBottom: false,
    });
    expect(container.scrollTop).toBe(140);
    expect(window.scrollY).toBe(0);
    expect(events).toEqual(['scroll']);
  });

  it('resolves the container through a selector', async () => {
    makeContainer();
    const outcome = await makeActions().scroll(options('BOTTOM', { selector: '#list' }));
    expect(outcome).toMatchObject({ moved: true, after: 800, atBottom: true });
  });

  it('pages a container UP, to the TOP, and reports container edges as no-ops', async () => {
    const container = makeContainer();
    const actions = makeActions();
    expect(await actions.scroll(options('UP'), undefined, container)).toMatchObject({
      moved: false,
      reason: 'edge',
      atTop: true,
      max: 800,
    });
    await actions.scroll(options('BOTTOM'), undefined, container);
    expect(await actions.scroll(options('DOWN'), undefined, container)).toMatchObject({
      moved: false,
      reason: 'edge',
      atBottom: true,
    });
    expect(await actions.scroll(options('UP'), undefined, container)).toMatchObject({
      moved: true,
      before: 800,
      after: 660,
    });
    expect(await actions.scroll(options('TOP'), undefined, container)).toMatchObject({
      moved: true,
      after: 0,
      atTop: true,
    });
  });

  it.each(['auto', 'scroll', 'overlay'])('accepts overflow-y:%s', async overflow => {
    const container = makeContainer(200, 1000, overflow);
    expect(await makeActions().scroll(options('DOWN'), undefined, container)).toMatchObject({
      moved: true,
    });
  });

  it.each(['visible', 'hidden'])(
    'refuses a container with overflow-y:%s as UNSUPPORTED_STATE',
    async overflow => {
      const container = makeContainer(200, 1000, overflow);
      const guard = createMutationGuard();
      expect(await codeOf(makeActions().scroll(options('DOWN'), guard, container))).toBe(
        'UNSUPPORTED_STATE'
      );
      expect(container.scrollTop).toBe(0);
      expect(guard.committed).toBe(false);
    }
  );

  it('refuses a container whose content fits as UNSUPPORTED_STATE', async () => {
    const container = makeContainer(200, 200);
    expect(await codeOf(makeActions().scroll(options('DOWN'), undefined, container))).toBe(
      'UNSUPPORTED_STATE'
    );
  });

  it('rejects stale and ambiguous selectors, invalid selectors and detached targets', async () => {
    mountHtml('<div class="pane"></div><div class="pane"></div>');
    expect(await codeOf(makeActions().scroll(options('DOWN', { selector: '#missing' })))).toBe(
      'TARGET_STALE'
    );
    expect(await codeOf(makeActions().scroll(options('DOWN', { selector: '.pane' })))).toBe(
      'TARGET_AMBIGUOUS'
    );
    expect(await codeOf(makeActions().scroll(options('DOWN', { selector: '##[' })))).toBe(
      'VALIDATION_FAILED'
    );
    const detached = document.createElement('div');
    expect(await codeOf(makeActions().scroll(options('DOWN'), undefined, detached))).toBe(
      'TARGET_STALE'
    );
    expect(window.scrollY).toBe(0);
  });
});

describe('scroll: guard and direction', () => {
  it('rejects EXECUTION_CANCELLED for an aborted signal and leaves the scroll position', async () => {
    const controller = new AbortController();
    controller.abort();
    const guard = createMutationGuard(controller.signal);
    expect(await codeOf(makeActions().scroll(options('DOWN'), guard))).toBe('EXECUTION_CANCELLED');
    expect(window.scrollY).toBe(0);
    expect(guard.committed).toBe(false);
  });

  it('rejects an unknown direction with VALIDATION_FAILED', async () => {
    const guard = createMutationGuard();
    const error = await failureOf(
      makeActions().scroll({ direction: 'SIDEWAYS' } as unknown as ScrollOptions, guard)
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(window.scrollY).toBe(0);
    expect(guard.committed).toBe(false);
  });

  it('scroll of strict.ts returns unions and never throws', () => {
    const controller = new AbortController();
    controller.abort();
    expect(scroll('DOWN', undefined, createMutationGuard(controller.signal))).toMatchObject({
      ok: false,
      code: 'EXECUTION_CANCELLED',
    });
    expect(scroll('UP', undefined, createMutationGuard())).toEqual({
      ok: true,
      outcome: pageOutcome({
        moved: false,
        reason: 'edge',
        before: 0,
        after: 0,
        atTop: true,
        atBottom: false,
      }),
    });
    const plain = document.createElement('div');
    document.body.appendChild(plain);
    expect(scroll('DOWN', plain, createMutationGuard())).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_STATE',
    });
  });
});
