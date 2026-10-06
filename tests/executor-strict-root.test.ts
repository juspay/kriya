import { DOMActions } from '@/actions/DOMActions';
import { resolveStrictElement } from '@/actions/strict';
import { DEFAULT_CONFIG } from '@/types';
import { DOMRoot } from '@/utils/DOMRoot';
import { installLayoutStubs, mountHtml, resetDom, setBox } from './helpers/domHarness';

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`fixture is missing #${id}`);
  }
  return element;
}

// toMatchObject would walk a DOM node's object graph; compare the element by identity instead.
function elementOf(result: ReturnType<typeof resolveStrictElement>): Element | undefined {
  return result.ok ? result.element : undefined;
}

function mountShadowApp(): ShadowRoot {
  mountHtml('<button class="go" id="outside">Outside</button><div id="host"></div>');
  const root = byId('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<button class="go" id="inside">Inside</button><button id="only">Only</button>';
  return root;
}

beforeEach(() => {
  resetDom();
  installLayoutStubs();
});

afterEach(() => {
  jest.restoreAllMocks();
  resetDom();
});

describe('strict resolution inside a scoped automation root', () => {
  it('resolves a selector inside the root even when the document holds a twin', () => {
    mountHtml(
      '<button class="go" id="outside">Outside</button><div id="app"><button class="go" id="inside">Inside</button></div>'
    );
    const scope = new DOMRoot({ root: byId('app') });
    expect(resolveStrictElement('.go', undefined)).toMatchObject({
      ok: false,
      code: 'TARGET_AMBIGUOUS',
    });
    expect(elementOf(resolveStrictElement('.go', undefined, scope))).toBe(byId('inside'));
  });

  it('does not see an element outside the root by selector', () => {
    mountHtml('<button id="outside">Outside</button><div id="app"></div>');
    const scope = new DOMRoot({ root: byId('app') });
    expect(resolveStrictElement('#outside', undefined)).toMatchObject({ ok: true });
    expect(resolveStrictElement('#outside', undefined, scope)).toMatchObject({
      ok: false,
      code: 'TARGET_STALE',
    });
  });

  it('refuses a target outside the root and accepts one inside it', () => {
    mountHtml(
      '<button id="outside">Outside</button><div id="app"><button id="inside"></button></div>'
    );
    const scope = new DOMRoot({ root: byId('app') });
    expect(resolveStrictElement(undefined, byId('outside'), scope)).toMatchObject({
      ok: false,
      code: 'TARGET_STALE',
    });
    expect(resolveStrictElement(undefined, byId('inside'), scope)).toMatchObject({ ok: true });
  });

  it('resolves inside a shadow root and refuses the host document element', () => {
    const root = mountShadowApp();
    const scope = new DOMRoot({ root });
    expect(resolveStrictElement('#only', undefined)).toMatchObject({
      ok: false,
      code: 'TARGET_STALE',
    });
    expect(resolveStrictElement('#only', undefined, scope)).toMatchObject({ ok: true });
    expect(elementOf(resolveStrictElement('.go', undefined, scope))).toBe(
      root.getElementById('inside')
    );
    expect(resolveStrictElement(undefined, byId('outside'), scope)).toMatchObject({
      ok: false,
      code: 'TARGET_STALE',
    });
    expect(
      resolveStrictElement(undefined, root.getElementById('inside') as HTMLElement, scope)
    ).toMatchObject({ ok: true });
  });

  it('reports an invalid selector the same way in and out of a root', () => {
    mountHtml('<div id="app"></div>');
    const scope = new DOMRoot({ root: byId('app') });
    expect(resolveStrictElement('##[', undefined)).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(resolveStrictElement('##[', undefined, scope)).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('strict click confined to a configured root', () => {
  it('activates the twin inside the root and never the one outside', async () => {
    mountHtml(
      '<button class="go" id="outside">Outside</button><div id="app"><button class="go" id="inside">Inside</button></div>'
    );
    setBox(byId('outside'), { top: 10, left: 10, width: 80, height: 30 });
    setBox(byId('inside'), { top: 100, left: 10, width: 80, height: 30 });
    const clicked: string[] = [];
    byId('outside').addEventListener('click', () => clicked.push('outside'));
    byId('inside').addEventListener('click', () => clicked.push('inside'));
    const actions = new DOMActions({ ...DEFAULT_CONFIG, root: byId('app') });
    actions.initialize();
    await actions.click({ button: 'left', clickCount: 1, selector: '.go', strict: true });
    expect(clicked).toEqual(['inside']);
  });
});
