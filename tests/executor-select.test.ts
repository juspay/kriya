import { randomBytes } from 'crypto';
import { DOMActions } from '@/actions/DOMActions';
import { createMutationGuard } from '@/actions/guard';
import { selectAriaOption, selectNative } from '@/actions/strict';
import type { ErrorCode, MutationGuard, SelectOptions } from '@/types';
import { AutomationError, DEFAULT_CONFIG } from '@/types';
import { resetDom } from './helpers/domHarness';

const NEEDLE = `n${randomBytes(8).toString('hex')}`;

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

function options(
  matchBy: SelectOptions['matchBy'],
  option: string,
  overrides: Partial<SelectOptions> = {}
): SelectOptions {
  return { matchBy, option, triggerEvents: true, ...overrides };
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

const COUNTRIES = `
  <select id="s">
    <option value="">Choose a country</option>
    <option value="us">United States</option>
    <option value="ca">
      Canada
    </option>
    <option value="mx" label="Mexico (MX)">Ignored text</option>
    <option value="de" disabled>Germany</option>
    <optgroup label="Locked" disabled><option value="fr">France</option></optgroup>
  </select>`;

beforeEach(() => {
  resetDom();
});

afterEach(() => {
  jest.restoreAllMocks();
  resetDom();
});

describe('select: native by index, value and label', () => {
  it('selects by index and reports a value-free outcome', async () => {
    html(COUNTRIES);
    const outcome = await makeActions().select(options('index', '1'), undefined, byId('s'));
    expect(byId<HTMLSelectElement>('s').value).toBe('us');
    expect(outcome).toEqual({
      kind: 'select',
      control: 'native',
      index: 1,
      changed: true,
      matched: true,
    });
  });

  it('selects by value', async () => {
    html(COUNTRIES);
    const outcome = await makeActions().select(options('value', 'ca'), undefined, byId('s'));
    expect(byId<HTMLSelectElement>('s').selectedIndex).toBe(2);
    expect(outcome).toMatchObject({ index: 2, matched: true });
  });

  it('selects by label, collapsing the whitespace of pretty-printed options', async () => {
    html(COUNTRIES);
    const outcome = await makeActions().select(options('label', 'Canada'), undefined, byId('s'));
    expect(byId<HTMLSelectElement>('s').value).toBe('ca');
    expect(outcome).toMatchObject({ index: 2, matched: true });
  });

  it('matches the whole label, never a prefix or a substring of it', async () => {
    html(COUNTRIES);
    expect(
      await codeOf(makeActions().select(options('label', 'United'), undefined, byId('s')))
    ).toBe('OPTION_NOT_FOUND');
    expect(
      await codeOf(makeActions().select(options('label', 'tates'), undefined, byId('s')))
    ).toBe('OPTION_NOT_FOUND');
    html(
      '<select id="s"><option value="a">Canada</option><option value="b">Canada (French)</option></select>'
    );
    const outcome = await makeActions().select(options('label', 'Canada'), undefined, byId('s'));
    expect(outcome).toMatchObject({ index: 0, matched: true });
    expect(byId<HTMLSelectElement>('s').value).toBe('a');
  });

  it('collapses the whitespace of the requested label too', async () => {
    html(COUNTRIES);
    const outcome = await makeActions().select(
      options('label', '  United \n  States  '),
      undefined,
      byId('s')
    );
    expect(byId<HTMLSelectElement>('s').value).toBe('us');
    expect(outcome).toMatchObject({ index: 1, matched: true });
  });

  it('prefers the label attribute over the option text', async () => {
    html(COUNTRIES);
    await makeActions().select(options('label', 'Mexico (MX)'), undefined, byId('s'));
    expect(byId<HTMLSelectElement>('s').value).toBe('mx');
    expect(
      await codeOf(makeActions().select(options('label', 'Ignored text'), undefined, byId('s')))
    ).toBe('OPTION_NOT_FOUND');
  });

  it('can select the blank placeholder option by its empty value', async () => {
    html(COUNTRIES);
    const select = byId<HTMLSelectElement>('s');
    select.value = 'us';
    const outcome = await makeActions().select(options('value', ''), undefined, select);
    expect(select.selectedIndex).toBe(0);
    expect(outcome).toMatchObject({ index: 0, changed: true, matched: true });
  });

  it('dispatches input then change, both bubbling, once, after the commit', async () => {
    html(`<form id="f">${COUNTRIES}</form>`);
    const trace: string[] = [];
    const inputs: boolean[] = [];
    byId('f').addEventListener('input', event => inputs.push(event.composed));
    recordEvents(['input', 'change'], trace);
    await makeActions().select(options('value', 'us'), tracedGuard(trace), byId('s'));
    expect(trace).toEqual(['commit', 'input@s', 'change@s']);
    expect(inputs).toEqual([true]);
  });

  it('makes input composed and change a plain bubbling event, neither cancelable', async () => {
    html(COUNTRIES);
    const flags: Record<string, boolean[]> = {};
    for (const type of ['input', 'change']) {
      byId('s').addEventListener(type, event => {
        flags[type] = [event.bubbles, event.cancelable, event.composed];
      });
    }
    await makeActions().select(options('value', 'us'), undefined, byId('s'));
    expect(flags).toEqual({ input: [true, false, true], change: [true, false, false] });
  });

  it('commits once, before the first mutation', async () => {
    html(COUNTRIES);
    const trace: string[] = [];
    const select = byId<HTMLSelectElement>('s');
    select.addEventListener('input', () => trace.push(`input:${select.value}`));
    await makeActions().select(options('value', 'us'), tracedGuard(trace), select);
    expect(trace).toEqual(['commit', 'input:us']);
  });

  it('honors triggerEvents:false: selects without events', async () => {
    html(COUNTRIES);
    const trace: string[] = [];
    recordEvents(['input', 'change'], trace);
    const outcome = await makeActions().select(
      options('value', 'us', { triggerEvents: false }),
      undefined,
      byId('s')
    );
    expect(trace).toEqual([]);
    expect(byId<HTMLSelectElement>('s').value).toBe('us');
    expect(outcome).toMatchObject({ matched: true, changed: true });
  });

  it('is idempotent: an already selected option is a no-op without events or a commit', async () => {
    html(COUNTRIES);
    const select = byId<HTMLSelectElement>('s');
    select.value = 'us';
    const trace: string[] = [];
    recordEvents(['input', 'change', 'focus'], trace);
    const guard = tracedGuard(trace);
    const outcome = await makeActions().select(options('value', 'us'), guard, select);
    expect(trace).toEqual([]);
    expect(guard.committed).toBe(false);
    expect(outcome).toEqual({
      kind: 'select',
      control: 'native',
      index: 1,
      changed: false,
      matched: true,
    });
  });

  it('reports matched:false when the page reverts the selection', async () => {
    html(COUNTRIES);
    const select = byId<HTMLSelectElement>('s');
    select.addEventListener('change', () => {
      select.selectedIndex = 0;
    });
    const outcome = await makeActions().select(options('value', 'us'), undefined, select);
    expect(outcome).toMatchObject({ kind: 'select', index: 1, changed: false, matched: false });
  });
});

describe('select: native failures', () => {
  it.each([
    ['value', 'zz'],
    ['label', 'Atlantis'],
    ['label', 'canada'],
    ['value', 'US'],
    ['index', '99'],
  ] as const)(
    'rejects %s "%s" with OPTION_NOT_FOUND and changes nothing',
    async (matchBy, option) => {
      html(COUNTRIES);
      const trace: string[] = [];
      recordEvents(['input', 'change'], trace);
      const guard = tracedGuard(trace);
      const code = await codeOf(makeActions().select(options(matchBy, option), guard, byId('s')));
      expect(code).toBe('OPTION_NOT_FOUND');
      expect(byId<HTMLSelectElement>('s').selectedIndex).toBe(0);
      expect(trace).toEqual([]);
      expect(guard.committed).toBe(false);
    }
  );

  it.each(['abc', '-1', '1.5', '', ' 1', '01', '1e0'])(
    'rejects the malformed index "%s" with VALIDATION_FAILED',
    async option => {
      html(COUNTRIES);
      expect(
        await codeOf(makeActions().select(options('index', option), undefined, byId('s')))
      ).toBe('VALIDATION_FAILED');
      expect(byId<HTMLSelectElement>('s').selectedIndex).toBe(0);
    }
  );

  it('never echoes the requested option in a message or context', async () => {
    html(COUNTRIES);
    for (const matchBy of ['value', 'label'] as const) {
      const error = await failureOf(
        makeActions().select(options(matchBy, NEEDLE), undefined, byId('s'))
      );
      expect(`${error.message} ${JSON.stringify(error.context ?? {})}`).not.toContain(NEEDLE);
    }
  });

  it('rejects an ambiguous value or label with OPTION_AMBIGUOUS', async () => {
    html(
      '<select id="s"><option value="a">One</option><option value="a">Two</option><option value="b">Same</option><option value="c">Same</option></select>'
    );
    expect(await codeOf(makeActions().select(options('value', 'a'), undefined, byId('s')))).toBe(
      'OPTION_AMBIGUOUS'
    );
    expect(await codeOf(makeActions().select(options('label', 'Same'), undefined, byId('s')))).toBe(
      'OPTION_AMBIGUOUS'
    );
    expect(byId<HTMLSelectElement>('s').selectedIndex).toBe(0);
  });

  it('rejects a disabled option and an option inside a disabled group with OPTION_DISABLED', async () => {
    html(COUNTRIES);
    const trace: string[] = [];
    recordEvents(['input', 'change'], trace);
    const guard = tracedGuard(trace);
    expect(await codeOf(makeActions().select(options('value', 'de'), guard, byId('s')))).toBe(
      'OPTION_DISABLED'
    );
    expect(await codeOf(makeActions().select(options('label', 'France'), guard, byId('s')))).toBe(
      'OPTION_DISABLED'
    );
    expect(byId<HTMLSelectElement>('s').selectedIndex).toBe(0);
    expect(trace).toEqual([]);
    expect(guard.committed).toBe(false);
  });

  it.each([
    ['disabled select', '<select id="s" disabled><option value="a">A</option></select>'],
    [
      'fieldset-disabled select',
      '<fieldset disabled><select id="s"><option value="a">A</option></select></fieldset>',
    ],
    [
      'aria-disabled select',
      '<select id="s" aria-disabled="true"><option value="a">A</option></select>',
    ],
  ])('rejects a %s with TARGET_DISABLED', async (_label, markup) => {
    html(markup);
    const guard = createMutationGuard();
    expect(await codeOf(makeActions().select(options('value', 'a'), guard, byId('s')))).toBe(
      'TARGET_DISABLED'
    );
    expect(guard.committed).toBe(false);
  });

  it('refuses a multiple select with UNSUPPORTED_STATE', async () => {
    html(
      '<select id="s" multiple><option value="a">A</option><option value="b">B</option></select>'
    );
    expect(await codeOf(makeActions().select(options('value', 'b'), undefined, byId('s')))).toBe(
      'UNSUPPORTED_STATE'
    );
    expect(byId<HTMLSelectElement>('s').selectedOptions).toHaveLength(0);
  });

  it.each([
    ['a text input', '<input id="t">'],
    ['a div', '<div id="t"></div>'],
    ['an option without role', '<select><option id="t" value="a">A</option></select>'],
    ['a role=button', '<div id="t" role="button"></div>'],
  ])('refuses %s as a select target with OPTION_NOT_FOUND', async (_label, markup) => {
    html(markup);
    const guard = createMutationGuard();
    expect(await codeOf(makeActions().select(options('value', 'a'), guard, byId('t')))).toBe(
      'OPTION_NOT_FOUND'
    );
    expect(guard.committed).toBe(false);
  });
});

describe('select: ARIA option path', () => {
  const LISTBOX = `
    <div id="trigger" role="combobox" aria-expanded="true">Pick</div>
    <ul id="list" role="listbox">
      <li id="o0" role="option" aria-selected="false">Red</li>
      <li id="o1" role="option" aria-selected="false">Green</li>
      <li id="o2" role="option" aria-selected="false">Blue</li>
    </ul>`;

  function chooseOnClick(option: HTMLElement, delayMs = 0): void {
    option.addEventListener('click', () => {
      const apply = (): void => {
        for (const other of document.querySelectorAll('[role="option"]')) {
          other.setAttribute('aria-selected', String(other === option));
        }
      };
      if (delayMs === 0) {
        apply();
      } else {
        setTimeout(apply, delayMs);
      }
    });
  }

  it('clicks the option once with the full pointer sequence and reports its position', async () => {
    html(LISTBOX);
    chooseOnClick(byId('o1'));
    const trace: string[] = [];
    recordEvents(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'], trace);
    const outcome = await makeActions().select(
      options('index', '0'),
      tracedGuard(trace),
      byId('o1')
    );
    expect(trace).toEqual([
      'commit',
      'pointerdown@o1',
      'mousedown@o1',
      'pointerup@o1',
      'mouseup@o1',
      'click@o1',
    ]);
    expect(byId('o1').getAttribute('aria-selected')).toBe('true');
    expect(outcome).toEqual({
      kind: 'select',
      control: 'aria',
      index: 1,
      changed: true,
      matched: true,
    });
  });

  it('reports the position among the listbox options, not among its children', async () => {
    html(`
      <ul id="list" role="listbox">
        <li role="presentation">Colors</li>
        <li id="o0" role="option" aria-selected="false">Red</li>
        <li role="group"><span id="o1" role="option" aria-selected="false">Green</span></li>
        <li id="o2" role="option" aria-selected="false">Blue</li>
      </ul>`);
    const outcome = await makeActions().select(options('index', '0'), undefined, byId('o2'));
    expect(outcome).toMatchObject({ kind: 'select', control: 'aria', index: 2 });
    const grouped = await makeActions().select(options('index', '0'), undefined, byId('o1'));
    expect(grouped).toMatchObject({ index: 1 });
  });

  it('ignores matchBy and option for an ARIA option target', async () => {
    html(LISTBOX);
    chooseOnClick(byId('o2'));
    const outcome = await makeActions().select(options('label', NEEDLE), undefined, byId('o2'));
    expect(outcome).toMatchObject({ control: 'aria', index: 2, matched: true });
  });

  it('resolves the option through a selector too', async () => {
    html(LISTBOX);
    chooseOnClick(byId('o0'));
    const outcome = await makeActions().select(options('value', 'x', { selector: '#o0' }));
    expect(outcome).toMatchObject({ control: 'aria', index: 0, matched: true });
  });

  it('is idempotent for an option that is already selected', async () => {
    html(LISTBOX);
    byId('o1').setAttribute('aria-selected', 'true');
    const clicks: string[] = [];
    byId('o1').addEventListener('click', () => clicks.push('click'));
    const guard = createMutationGuard();
    const outcome = await makeActions().select(options('value', 'x'), guard, byId('o1'));
    expect(clicks).toEqual([]);
    expect(guard.committed).toBe(false);
    expect(outcome).toEqual({
      kind: 'select',
      control: 'aria',
      index: 1,
      changed: false,
      matched: true,
    });
  });

  it('settles a widget that updates asynchronously, with one click', async () => {
    html(LISTBOX);
    chooseOnClick(byId('o2'), 40);
    const clicks: string[] = [];
    byId('o2').addEventListener('click', () => clicks.push('click'));
    const outcome = await makeActions().select(options('value', 'x'), undefined, byId('o2'));
    expect(outcome).toMatchObject({ control: 'aria', matched: true, changed: true });
    expect(clicks).toEqual(['click']);
  });

  it('reports matched:null when the popup closes and the option leaves the document', async () => {
    html(LISTBOX);
    byId('o1').addEventListener('click', () => byId('list').remove());
    const outcome = await makeActions().select(options('value', 'x'), undefined, byId('o1'));
    expect(outcome).toEqual({
      kind: 'select',
      control: 'aria',
      index: 1,
      changed: true,
      matched: null,
    });
  });

  it('reports matched:false when the widget never marks the option selected, without a second click', async () => {
    html(LISTBOX);
    const clicks: string[] = [];
    byId('o1').addEventListener('click', () => clicks.push('click'));
    const outcome = await makeActions().select(options('value', 'x'), undefined, byId('o1'));
    expect(clicks).toEqual(['click']);
    expect(outcome).toMatchObject({ control: 'aria', changed: false, matched: false });
  });

  it('rejects an aria-disabled option with OPTION_DISABLED', async () => {
    html(LISTBOX);
    byId('o1').setAttribute('aria-disabled', 'true');
    const clicks: string[] = [];
    byId('o1').addEventListener('click', () => clicks.push('click'));
    expect(await codeOf(makeActions().select(options('value', 'x'), undefined, byId('o1')))).toBe(
      'OPTION_DISABLED'
    );
    expect(clicks).toEqual([]);
  });

  it('rejects an option that has no owning listbox with UNSUPPORTED_STATE', async () => {
    html('<div id="o" role="option" aria-selected="false">Loose</div>');
    expect(await codeOf(makeActions().select(options('value', 'x'), undefined, byId('o')))).toBe(
      'UNSUPPORTED_STATE'
    );
  });

  it('cancels before the click for an aborted signal', async () => {
    html(LISTBOX);
    const controller = new AbortController();
    controller.abort();
    const clicks: string[] = [];
    byId('o1').addEventListener('click', () => clicks.push('click'));
    const guard = createMutationGuard(controller.signal);
    expect(await codeOf(makeActions().select(options('value', 'x'), guard, byId('o1')))).toBe(
      'EXECUTION_CANCELLED'
    );
    expect(clicks).toEqual([]);
    expect(guard.committed).toBe(false);
  });

  it('keeps the effect uncertain when an abort lands during the settle poll', async () => {
    html(LISTBOX);
    const controller = new AbortController();
    const guard = createMutationGuard(controller.signal);
    const run = makeActions().select(options('value', 'x'), guard, byId('o1'));
    setTimeout(() => controller.abort(), 30);
    expect(await codeOf(run)).toBe('EXECUTION_CANCELLED');
    expect(guard.committed).toBe(true);
  });
});

describe('select: target resolution', () => {
  it('resolves a CSS selector for a native select', async () => {
    html(COUNTRIES);
    await makeActions().select(options('value', 'us', { selector: '#s' }));
    expect(byId<HTMLSelectElement>('s').value).toBe('us');
  });

  it('rejects a stale, ambiguous or invalid selector and a detached target', async () => {
    html(
      '<select class="x"><option value="a">A</option></select><select class="x"><option value="a">A</option></select>'
    );
    expect(await codeOf(makeActions().select(options('value', 'a', { selector: '#none' })))).toBe(
      'TARGET_STALE'
    );
    expect(await codeOf(makeActions().select(options('value', 'a', { selector: '.x' })))).toBe(
      'TARGET_AMBIGUOUS'
    );
    expect(await codeOf(makeActions().select(options('value', 'a', { selector: '##[' })))).toBe(
      'VALIDATION_FAILED'
    );
    const detached = document.createElement('select');
    expect(await codeOf(makeActions().select(options('value', 'a'), undefined, detached))).toBe(
      'TARGET_STALE'
    );
  });

  it('fails INVALID_ACTION with no commit and no text matching when nothing identifies the target', async () => {
    html(COUNTRIES);
    const guard = createMutationGuard();
    const error = await failureOf(
      makeActions().select(options('value', 'us', { description: 'country' }), guard)
    );
    expect(error.code).toBe('INVALID_ACTION');
    expect(byId<HTMLSelectElement>('s').selectedIndex).toBe(0);
    expect(guard.committed).toBe(false);
    expect(error.message).not.toContain('country');
  });
});

describe('select: guard and strict.ts unions', () => {
  it('rejects EXECUTION_CANCELLED before any change for an aborted signal', async () => {
    html(COUNTRIES);
    const controller = new AbortController();
    controller.abort();
    const guard = createMutationGuard(controller.signal);
    expect(await codeOf(makeActions().select(options('value', 'us'), guard, byId('s')))).toBe(
      'EXECUTION_CANCELLED'
    );
    expect(byId<HTMLSelectElement>('s').selectedIndex).toBe(0);
    expect(guard.committed).toBe(false);
  });

  it('selectNative and selectAriaOption return unions and never throw', async () => {
    html(COUNTRIES);
    const select = byId<HTMLSelectElement>('s');
    expect(selectNative(select, 'value', 'zz', true, createMutationGuard())).toMatchObject({
      ok: false,
      code: 'OPTION_NOT_FOUND',
    });
    const controller = new AbortController();
    controller.abort();
    expect(
      selectNative(select, 'value', 'us', true, createMutationGuard(controller.signal))
    ).toMatchObject({ ok: false, code: 'EXECUTION_CANCELLED' });
    expect(selectNative(select, 'value', 'us', true, createMutationGuard())).toEqual({
      ok: true,
      outcome: { kind: 'select', control: 'native', index: 1, changed: true, matched: true },
    });
    html('<div id="o" role="option"></div>');
    expect(await selectAriaOption(byId('o'), createMutationGuard())).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_STATE',
    });
  });

  it('survives a JSON round trip', async () => {
    html(COUNTRIES);
    const outcome = await makeActions().select(options('value', 'us'), undefined, byId('s'));
    expect(JSON.parse(JSON.stringify(outcome))).toEqual(outcome);
  });
});

describe('select: runtime type safety', () => {
  it('rejects an unknown matchBy instead of treating it as an index', async () => {
    html(COUNTRIES);
    const guard = createMutationGuard();
    const code = await codeOf(
      makeActions().select(
        options('bogus' as unknown as SelectOptions['matchBy'], '1'),
        guard,
        byId('s')
      )
    );
    expect(code).toBe('VALIDATION_FAILED');
    expect(byId<HTMLSelectElement>('s').selectedIndex).toBe(0);
    expect(guard.committed).toBe(false);
  });

  it('rejects a non-string option', async () => {
    html(COUNTRIES);
    const code = await codeOf(
      makeActions().select(options('index', 1 as unknown as string), undefined, byId('s'))
    );
    expect(code).toBe('VALIDATION_FAILED');
    expect(byId<HTMLSelectElement>('s').selectedIndex).toBe(0);
  });
});
