import type { AutomationConfig, AutomationLocationProvider, AutomationRoot } from '../src';
import * as sourceKriya from '../src';
import html2canvas from 'html2canvas';

jest.mock('html2canvas', () => jest.fn());

const kriya: typeof import('../src') = process.env.KRIYA_TEST_BUNDLE
  ? jest.requireActual(process.env.KRIYA_TEST_BUNDLE)
  : sourceKriya;

const createFixture = (): { host: HTMLElement; root: ShadowRoot; form: HTMLFormElement } => {
  document.body.innerHTML = `
    <label for="email">Host email label</label>
    <form id="host-form"><input id="email" name="email" value="host-value"></form>
    <button id="outside-button">Host button</button>
    <div id="shadow-host"></div>`;
  const host = document.getElementById('shadow-host') as HTMLElement;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <form id="app-form">
      <label for="email">App email label</label>
      <input id="email" name="email" type="email" value="app-value">
      <button id="action-button" type="button">Save preferences</button>
      <button id="submit-button" type="submit">Submit preferences</button>
    </form>`;
  return { host, root, form: root.querySelector('form') as HTMLFormElement };
};

const configFor = (root?: AutomationRoot): AutomationConfig => ({
  ...kriya.DEFAULT_CONFIG,
  root,
  screenshotOnError: false,
  debugMode: false,
});

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = jest.fn();
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    x: 10,
    y: 10,
    left: 10,
    top: 10,
    right: 210,
    bottom: 50,
    width: 200,
    height: 40,
    toJSON: () => ({}),
  }));
});

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Host page';
  jest.mocked(html2canvas).mockResolvedValue({
    toDataURL: () => 'data:image/png;base64,fixture',
  } as HTMLCanvasElement);
});

test('shadow fixture finds, fills, clicks, detects forms and captures only app context', async () => {
  const { root } = createFixture();
  const engine = kriya.createAutomationEngine(configFor(root));
  engine.initialize();
  const clickListener = jest.fn();
  root.querySelector('#action-button')?.addEventListener('click', clickListener);
  try {
    const filled = await engine.executeAction({
      type: 'fill',
      parameters: { description: 'App email label', value: 'app@example.com' },
    });
    expect(filled.success).toBe(true);
    expect((root.getElementById('email') as HTMLInputElement).value).toBe('app@example.com');
    expect((document.getElementById('email') as HTMLInputElement).value).toBe('host-value');
    expect(
      (await engine.executeAction({ type: 'click', parameters: { selector: '#action-button' } }))
        .success
    ).toBe(true);
    expect(clickListener).toHaveBeenCalledTimes(1);
    const context = await engine.capturePageContext();
    expect(context.totalFormsFound).toBe(1);
    expect(context.elements.some(element => element.id === 'app-form')).toBe(true);
    expect(context.elements.some(element => element.id === 'host-form')).toBe(false);
    const detector = new kriya.EnhancedFormDetector({ root, debugMode: false });
    expect(detector.getForms().map(form => form.id)).toEqual(['app-form']);
    expect(detector.getForms()[0]?.fields.get('email')?.label).toBe('App email label');
  } finally {
    engine.dispose();
  }
});

test('shadow CSS fill, press active element and wait target stay scoped', async () => {
  const { root } = createFixture();
  const engine = kriya.createAutomationEngine(configFor(root));
  engine.initialize();
  try {
    expect(
      (
        await engine.executeAction({
          type: 'fill',
          parameters: { selector: '#email', value: 'second@example.com' },
        })
      ).success
    ).toBe(true);
    const input = root.getElementById('email') as HTMLInputElement;
    input.focus();
    const keyboardListener = jest.fn();
    input.addEventListener('keydown', keyboardListener);
    expect(
      (await engine.executeAction({ type: 'press', parameters: { key: 'Enter' } })).success
    ).toBe(true);
    expect(keyboardListener).toHaveBeenCalledTimes(1);
    expect(
      (
        await engine.executeAction({
          type: 'wait',
          parameters: { selector: '#email', condition: 'enabled' },
        })
      ).success
    ).toBe(true);
    expect(
      (await engine.executeAction({ type: 'click', parameters: { selector: '#outside-button' } }))
        .errorCode
    ).toBe('ELEMENT_NOT_FOUND');
  } finally {
    engine.dispose();
  }
});

test('shadow fillForm threads root into the enhanced detector and native registry', async () => {
  const { root, form } = createFixture();
  const registry = new kriya.FormRegistry(configFor(root));
  registry.initialize();
  try {
    expect(registry.getFormContext().map(context => context.formId)).toEqual(['app-form']);
    expect(registry.getFormContext()[0]?.fields[0]?.label).toBe('App email label');
    expect((await registry.fillForm('app-form', { email: 'native@example.com' })).success).toBe(
      true
    );
    expect((form.elements.namedItem('email') as HTMLInputElement).value).toBe('native@example.com');
    expect((await registry.fillAnyForm({ email: 'enhanced@example.com' })).success).toBe(true);
    expect((form.elements.namedItem('email') as HTMLInputElement).value).toBe(
      'enhanced@example.com'
    );
    expect((document.getElementById('email') as HTMLInputElement).value).toBe('host-value');
    expect(() =>
      registry.registerForm('external', document.getElementById('host-form') as HTMLFormElement)
    ).toThrow('outside the configured root');
  } finally {
    registry.dispose();
  }
});

test('element root includes its form and excludes surrounding labels and clickable parents', async () => {
  document.body.innerHTML = `<button id="outer-button"><section id="app-root"><span id="leaf">Leaf</span></section></button>
    <label for="field">Outside label</label><form id="root-form"><input id="field" name="field" type="text"></form>`;
  const root = document.getElementById('app-root') as HTMLElement;
  const dom = new kriya.DOMActions(configFor(root));
  dom.initialize();
  const parentListener = jest.fn();
  document.getElementById('outer-button')?.addEventListener('click', parentListener);
  try {
    await expect(dom.click({ selector: '#leaf', button: 'left', clickCount: 1 })).rejects.toThrow(
      'not clickable'
    );
    expect(parentListener).not.toHaveBeenCalled();
    const formRoot = document.getElementById('root-form') as HTMLFormElement;
    const registry = new kriya.FormRegistry(configFor(formRoot));
    registry.initialize();
    expect(registry.getFormContext().map(form => form.formId)).toEqual(['root-form']);
    expect(registry.getFormContext()[0]?.fields[0]?.label).toBeUndefined();
    registry.dispose();
  } finally {
    dom.dispose();
  }
});

test('element root inside a shadow tree uses its own active element and stops at the root boundary', async () => {
  const { root, form } = createFixture();
  const dom = new kriya.DOMActions(configFor(form));
  dom.initialize();
  const input = root.getElementById('email') as HTMLInputElement;
  input.focus();
  const pressed = jest.fn();
  input.addEventListener('keydown', pressed);
  try {
    await dom.press({ key: 'Enter' });
    expect(pressed).toHaveBeenCalledTimes(1);
    await dom.fill({
      description: 'App email label',
      value: 'element@example.com',
      clearFirst: true,
      triggerEvents: true,
    });
    expect(input.value).toBe('element@example.com');
  } finally {
    dom.dispose();
  }
});

test.each(['click', 'input', 'change'])(
  'synthetic %s bubbles and composes across the shadow host',
  async eventType => {
    const { root, host } = createFixture();
    const dom = new kriya.DOMActions(configFor(root));
    dom.initialize();
    const events: Event[] = [];
    const listener = (event: Event): void => {
      events.push(event);
    };
    document.addEventListener(eventType, listener);
    try {
      if (eventType === 'click') {
        await dom.click({ selector: '#action-button', button: 'left', clickCount: 1 });
      } else {
        await dom.fill({
          description: 'App email label',
          value: 'composed@example.com',
          clearFirst: false,
          triggerEvents: true,
        });
      }
      expect(events).toHaveLength(1);
      expect(events[0]?.bubbles).toBe(true);
      expect(events[0]?.composed).toBe(true);
      expect(events[0]?.target).toBe(host);
    } finally {
      document.removeEventListener(eventType, listener);
      dom.dispose();
    }
  }
);

test('native shadow submit crosses once with its submitter and cancellation reaches the original event', () => {
  const { root, form, host } = createFixture();
  const registry = new kriya.FormRegistry(configFor(root));
  registry.initialize();
  const submitter = root.getElementById('submit-button') as HTMLButtonElement;
  const local = jest.fn();
  const outerEvents: SubmitEvent[] = [];
  form.addEventListener('submit', local);
  const listener = (event: Event): void => {
    outerEvents.push(event as SubmitEvent);
    event.preventDefault();
  };
  document.addEventListener('submit', listener);
  try {
    const native = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter });
    expect(form.dispatchEvent(native)).toBe(false);
    expect(local).toHaveBeenCalledTimes(1);
    expect(outerEvents).toHaveLength(1);
    expect(outerEvents[0]?.composed).toBe(true);
    expect(outerEvents[0]?.bubbles).toBe(true);
    expect(outerEvents[0]?.submitter).toBe(submitter);
    expect(outerEvents[0]?.target).toBe(host);
    expect(native.defaultPrevented).toBe(true);
    registry.dispose();
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    expect(outerEvents).toHaveLength(1);
  } finally {
    document.removeEventListener('submit', listener);
    registry.dispose();
  }
});

test('submit action dispatches through requestSubmit and honors host cancellation even without a button', async () => {
  const { root, form } = createFixture();
  (root.getElementById('email') as HTMLInputElement).value = 'valid@example.com';
  root.getElementById('submit-button')?.remove();
  const registry = new kriya.FormRegistry(configFor(root));
  registry.initialize();
  const requestSubmit = jest.spyOn(form, 'requestSubmit');
  const listener = jest.fn((event: Event) => event.preventDefault());
  document.addEventListener('submit', listener);
  try {
    await expect(registry.submitForm('app-form')).rejects.toThrow('prevented');
    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  } finally {
    document.removeEventListener('submit', listener);
    registry.dispose();
  }
});

test('location provider supplies live app context and completes asynchronous navigation without a window load', async () => {
  const { root } = createFixture();
  let href = 'https://app.example.test/preferences';
  let title = 'App preferences';
  const locationProvider: AutomationLocationProvider = {
    getHref: () => href,
    getTitle: () => title,
    navigate: jest.fn(async url => {
      href = url;
      title = 'Next app page';
    }),
  };
  const engine = kriya.createAutomationEngine({ ...configFor(root), locationProvider });
  engine.initialize();
  try {
    expect(await engine.capturePageContext()).toMatchObject({ pageUrl: href, title });
    expect(
      (
        await engine.executeAction({
          type: 'navigate',
          parameters: { url: 'https://app.example.test/next', waitForLoad: 'true' },
        })
      ).success
    ).toBe(true);
    expect(locationProvider.navigate).toHaveBeenCalledWith('https://app.example.test/next');
    expect(await engine.capturePageContext()).toMatchObject({
      pageUrl: 'https://app.example.test/next',
      title: 'Next app page',
    });
    expect(window.location.href).toBe('http://localhost/');
  } finally {
    engine.dispose();
  }
});

test('provider navigation failures retain NETWORK_ERROR and optional title uses owner document', async () => {
  const { root } = createFixture();
  const engine = kriya.createAutomationEngine({
    ...configFor(root),
    locationProvider: {
      getHref: () => 'https://app.example.test/',
      navigate: async () => {
        throw new Error('Route failed');
      },
    },
  });
  engine.initialize();
  try {
    expect((await engine.capturePageContext()).title).toBe('Host page');
    expect(
      await engine.executeAction({ type: 'navigate', parameters: { url: '/next' } })
    ).toMatchObject({
      success: false,
      errorCode: 'NETWORK_ERROR',
      error: 'Navigation failed: Route failed',
    });
  } finally {
    engine.dispose();
  }
});

test.each(['document-full', 'document-viewport', 'shadow-full', 'shadow-viewport', 'element-full'])(
  'screenshot target follows %s',
  async mode => {
    const { root, host, form } = createFixture();
    const selectedRoot = mode.startsWith('shadow')
      ? root
      : mode.startsWith('element')
        ? form
        : undefined;
    const capture = new kriya.ContextCapture(configFor(selectedRoot));
    capture.initialize();
    try {
      expect(await capture.captureScreenshot({ fullPage: !mode.endsWith('viewport') })).toBe(
        'data:image/png;base64,fixture'
      );
      expect(jest.mocked(html2canvas)).toHaveBeenCalledWith(
        selectedRoot === root
          ? host
          : selectedRoot === form
            ? form
            : mode.endsWith('viewport')
              ? document.documentElement
              : document.body,
        expect.any(Object)
      );
    } finally {
      capture.dispose();
    }
  }
);

test.each(['document-default', 'shadow-root', 'element-root'])(
  'FormRegistry SelectBox select event preserves flags and reaches the host for %s',
  async mode => {
    document.body.innerHTML = '<div id="select-host"></div>';
    const host = document.getElementById('select-host') as HTMLElement;
    const container = mode === 'document-default' ? host : host.attachShadow({ mode: 'open' });
    container.innerHTML = `
      <form id="select-form">
        <div name="country" data-selectbox-value="">
          <button type="button" data-value=""><span data-button-text>Choose country</span></button>
        </div>
      </form>`;
    const form = container.querySelector('form') as HTMLFormElement;
    const selectBox = form.querySelector('[data-selectbox-value]') as HTMLElement;
    const trigger = selectBox.querySelector('button') as HTMLButtonElement;
    trigger.addEventListener('click', () => {
      const dropdown = document.createElement('div');
      dropdown.setAttribute('data-dropdown', 'dropdown');
      dropdown.innerHTML = '<button type="button" data-dropdown-value="IN">India</button>';
      selectBox.append(dropdown);
    });
    const configuredRoot =
      mode === 'document-default' ? undefined : mode === 'element-root' ? form : container;
    const registry = new kriya.FormRegistry(configFor(configuredRoot));
    const localListener = jest.fn((event: Event) => event.target);
    const hostListener = jest.fn((event: Event) => event.target);
    selectBox.addEventListener('select', localListener);
    host.addEventListener('select', hostListener);
    jest.useFakeTimers();
    try {
      registry.initialize();
      const filling = registry.fillForm('select-form', { country: 'IN' });
      await jest.runAllTimersAsync();
      expect(await filling).toMatchObject({ success: true, filledFields: ['country'] });
      expect(trigger.getAttribute('data-value')).toBe('IN');
      expect(trigger.querySelector('[data-button-text]')?.textContent).toBe('India');
      expect(localListener).toHaveBeenCalledTimes(1);
      const event = localListener.mock.calls[0]?.[0] as CustomEvent<{ value: string }>;
      expect(event.detail).toEqual({ value: 'IN' });
      expect(event.bubbles).toBe(true);
      expect(event.cancelable).toBe(false);
      expect(hostListener).toHaveBeenCalledTimes(1);
      expect(event.composed).toBe(mode !== 'document-default');
      expect(hostListener.mock.calls[0]?.[0]).toBe(event);
      expect(localListener.mock.results[0]?.value).toBe(selectBox);
      expect(hostListener.mock.results[0]?.value).toBe(
        mode === 'document-default' ? selectBox : host
      );
    } finally {
      registry.dispose();
      jest.useRealTimers();
    }
  }
);

test('document default control matches pre-change configuration, context and event flags', async () => {
  document.body.innerHTML =
    '<form id="document-form"><label for="email">Document email</label><input id="email" name="email" type="text"><button id="save" type="button">Save</button></form>';
  expect(kriya.DEFAULT_CONFIG).toEqual({
    timeout: 5000,
    retryAttempts: 3,
    screenshotOnError: true,
    debugMode: false,
    formDetectionEnabled: true,
    contextCaptureEnabled: true,
  });
  const engine = kriya.createAutomationEngine({ screenshotOnError: false });
  engine.initialize();
  const inputEvents: Event[] = [];
  const listener = (event: Event): void => {
    inputEvents.push(event);
  };
  document.addEventListener('input', listener);
  try {
    expect(
      (
        await engine.executeAction({
          type: 'fill',
          parameters: { description: 'Document email', value: 'document@example.com' },
        })
      ).success
    ).toBe(true);
    expect((document.getElementById('email') as HTMLInputElement).value).toBe(
      'document@example.com'
    );
    expect(inputEvents).toHaveLength(1);
    expect(inputEvents[0]?.composed).toBe(false);
    expect(inputEvents[0]?.bubbles).toBe(true);
    expect(await engine.capturePageContext()).toMatchObject({
      pageUrl: 'http://localhost/',
      title: 'Host page',
      totalFormsFound: 1,
    });
  } finally {
    document.removeEventListener('input', listener);
    engine.dispose();
  }
});

test('explicit document root detects document forms and does not pierce the nested shadow tree', async () => {
  createFixture();
  const engine = kriya.createAutomationEngine(configFor(document));
  engine.initialize();
  try {
    expect(await engine.capturePageContext()).toMatchObject({
      totalFormsFound: 1,
      pageUrl: 'http://localhost/',
    });
    expect(
      (await engine.executeAction({ type: 'click', parameters: { selector: '#action-button' } }))
        .errorCode
    ).toBe('ELEMENT_NOT_FOUND');
    expect(
      new kriya.EnhancedFormDetector({ root: document, debugMode: false })
        .getForms()
        .map(form => form.id)
    ).toEqual(['host-form']);
  } finally {
    engine.dispose();
  }
});

test('element fill fallback does not reach an input sibling outside the configured root', async () => {
  document.body.innerHTML =
    '<label id="root-label">App label</label><input id="external-input" value="unchanged">';
  const root = document.getElementById('root-label') as HTMLElement;
  const dom = new kriya.DOMActions(configFor(root));
  dom.initialize();
  try {
    await expect(
      dom.fill({
        selector: '#root-label',
        value: 'escaped',
        clearFirst: false,
        triggerEvents: true,
      })
    ).rejects.toThrow('not fillable');
    expect((document.getElementById('external-input') as HTMLInputElement).value).toBe('unchanged');
  } finally {
    dom.dispose();
  }
});

test('direct DOM provider navigation honors timeout', async () => {
  const { root } = createFixture();
  const dom = new kriya.DOMActions({
    ...configFor(root),
    locationProvider: {
      getHref: () => 'https://app.example.test/',
      navigate: () => new Promise<void>(() => {}),
    },
  });
  dom.initialize();
  try {
    await expect(
      dom.navigate({ url: '/blocked', waitForLoad: true, timeout: 20 })
    ).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'Navigation failed: Navigation timeout after 20ms',
    });
  } finally {
    dom.dispose();
  }
});

test('relative blank links resolve against the live provider route', async () => {
  document.body.innerHTML =
    '<section id="app"><a id="link" href="./next" target="_blank">Next</a></section>';
  const opened = jest.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);
  const root = document.getElementById('app') as HTMLElement;
  const hrefs: string[] = [];
  const link = document.getElementById('link') as HTMLAnchorElement;
  link.addEventListener('click', () => {
    hrefs.push(link.href);
  });
  const dom = new kriya.DOMActions({
    ...configFor(root),
    locationProvider: {
      getHref: () => 'https://app.example.test/preferences/current',
      navigate: () => {},
    },
  });
  dom.initialize();
  try {
    await dom.click({ selector: '#link', button: 'left', clickCount: 1 });
    expect(hrefs).toEqual(['https://app.example.test/preferences/next']);
    expect(opened).not.toHaveBeenCalled();
  } finally {
    opened.mockRestore();
    dom.dispose();
  }
});

test('review pin: Element root is included in text wait fallback', async () => {
  document.body.innerHTML = '<button id="root-button">Save</button>';
  const root = document.getElementById('root-button') as HTMLElement;
  const dom = new kriya.DOMActions(configFor(root));
  dom.initialize();
  try {
    await expect(
      dom.wait({ selector: 'Save', condition: 'visible', timeout: 30 })
    ).resolves.toBeUndefined();
  } finally {
    dom.dispose();
  }
});

test('review pin: canceled shadow button click is delivered once', async () => {
  const { root } = createFixture();
  const dom = new kriya.DOMActions(configFor(root));
  dom.initialize();
  const listener = jest.fn((event: Event) => event.preventDefault());
  document.addEventListener('click', listener);
  try {
    await dom.click({ selector: '#action-button', button: 'left', clickCount: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
  } finally {
    document.removeEventListener('click', listener);
    dom.dispose();
  }
});

test('review pin: canceled provider blank link never opens a fallback window', async () => {
  document.body.innerHTML =
    '<section id="app"><a id="link" href="./next" target="_blank">Next</a></section>';
  const root = document.getElementById('app') as HTMLElement;
  const dom = new kriya.DOMActions({
    ...configFor(root),
    locationProvider: {
      getHref: () => 'https://app.example.test/preferences/current',
      navigate: () => {},
    },
  });
  dom.initialize();
  const opened = jest.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);
  const listener = jest.fn((event: Event) => event.preventDefault());
  document.addEventListener('click', listener);
  try {
    await dom.click({ selector: '#link', button: 'left', clickCount: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(opened).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener('click', listener);
    opened.mockRestore();
    dom.dispose();
  }
});

test.each(['_self', '_blank'])(
  'review pin: provider %s link is resolved before click dispatch',
  async target => {
    document.body.innerHTML = `<section id="app"><a id="link" href="./next" target="${target}">Next</a></section>`;
    const root = document.getElementById('app') as HTMLElement;
    const link = document.getElementById('link') as HTMLAnchorElement;
    const hrefs: string[] = [];
    link.addEventListener('click', event => {
      hrefs.push(link.href);
      event.preventDefault();
    });
    const dom = new kriya.DOMActions({
      ...configFor(root),
      locationProvider: {
        getHref: () => 'https://app.example.test/preferences/current',
        navigate: () => {},
      },
    });
    dom.initialize();
    const opened = jest.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);
    try {
      await dom.click({ selector: '#link', button: 'left', clickCount: 1 });
      expect(hrefs).toEqual(['https://app.example.test/preferences/next']);
      expect(link.getAttribute('href')).toBe('./next');
    } finally {
      opened.mockRestore();
      dom.dispose();
    }
  }
);

test.each(['./next', ''])(
  'positioned provider click resolves href %s before dispatch',
  async href => {
    document.body.innerHTML = `<section id="app"><a id="link" href="${href}">Next</a></section>`;
    const root = document.getElementById('app') as HTMLElement;
    const link = document.getElementById('link') as HTMLAnchorElement;
    const hrefs: string[] = [];
    link.addEventListener('click', event => {
      hrefs.push(link.href);
      event.preventDefault();
    });
    const dom = new kriya.DOMActions({
      ...configFor(root),
      locationProvider: {
        getHref: () => 'https://app.example.test/preferences/current',
        navigate: () => {},
      },
    });
    dom.initialize();
    try {
      await dom.click({
        selector: '#link',
        position: { x: 2, y: 2 },
        button: 'left',
        clickCount: 1,
      });
      expect(hrefs).toEqual([
        href
          ? 'https://app.example.test/preferences/next'
          : 'https://app.example.test/preferences/current',
      ]);
      expect(link.getAttribute('href')).toBe(href);
    } finally {
      dom.dispose();
    }
  }
);
