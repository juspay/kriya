/*
 * jsdom has no layout and no scrolling. This harness gives tests a deterministic one, so that code which
 * observes or drives a page sees elements "as rendered":
 *
 * - Boxes are in VIEWPORT coordinates and stay put (the way tests/research-guide.test.ts mocks rects);
 *   scrolling moves scrollY, never a box.
 * - A boxed element reports its box through getBoundingClientRect, getClientRects and the offset and client
 *   sizes. It reports nothing (zero rect, no client rects, offsetParent null) while it is detached or inside
 *   display:none, exactly what a browser does; visibility:hidden keeps its geometry.
 * - The page scroll model is instant: scrollTo and scrollBy (on window and on document.scrollingElement)
 *   clamp to [0, scrollHeight - innerHeight], ignore `behavior`, and fire one `scroll` event only when the
 *   position changed. Scroll containers get the same model through makeScrollable (vertical only); scrollTo
 *   on any other element does nothing.
 * - elementFromPoint and elementsFromPoint throw a TypeError for a missing or non-finite coordinate, as a
 *   browser does, so a NaN computed by the code under test cannot silently hit every box.
 * - jsdom has no innerText; there is none here either, so code under test must fall back to textContent.
 *
 * - offsetParent is null for position:fixed elements, as in a browser, and the body for any other rendered
 *   element.
 *
 * Every global the harness changes is restored by resetDom(); call it in beforeEach and afterEach. Needs the
 * default jsdom Jest environment: DOM-bound tests only.
 *
 * Where it is more lenient than a browser (a test that depends on one of these needs Chromium, or its own
 * stub): boxes never move when the page or a container scrolls, hit testing follows document order (no
 * z-index, no overflow clipping, no inert, no top layer), the content of a closed <details> still renders,
 * scrollIntoView does nothing, scroll events fire synchronously, and listeners a test adds to window or
 * document are not removed by resetDom.
 */

export type Box = {
  readonly top: number;
  readonly left?: number;
  readonly width?: number;
  readonly height?: number;
};

export type Viewport = {
  readonly width?: number;
  readonly height?: number;
  readonly scrollY?: number;
  readonly scrollHeight?: number;
};

export type Scrollable = {
  readonly scrollHeight: number;
  /** Default: the rendered height of the element's box. */
  readonly clientHeight?: number;
  /** Default 0, clamped like any other scroll. */
  readonly scrollTop?: number;
};

type Rect = {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
};

type PageScroll = { top: number; height: number | undefined };

type ScrollModel = {
  top: number;
  readonly height: number;
  readonly client: number | undefined;
};

type VisibilityOptions = {
  readonly checkOpacity?: boolean;
  readonly opacityProperty?: boolean;
  readonly checkVisibilityCSS?: boolean;
  readonly visibilityProperty?: boolean;
};

const DEFAULT_LEFT = 10;
const DEFAULT_WIDTH = 160;
const DEFAULT_HEIGHT = 32;
const ZERO_RECT: Rect = { top: 0, left: 0, width: 0, height: 0 };

const boxes = new WeakMap<Element, Rect>();
const scrollers = new WeakMap<Element, ScrollModel>();
const restorers: Array<() => void> = [];
const pageScroll: PageScroll = { top: 0, height: undefined };
let pageScrollInstalled = false;
let stubsInstalled = false;

function toRect(box: Box): Rect {
  return {
    top: box.top,
    left: box.left ?? DEFAULT_LEFT,
    width: box.width ?? DEFAULT_WIDTH,
    height: box.height ?? DEFAULT_HEIGHT,
  };
}

function domRect(rect: Rect): DOMRect {
  const fields = {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    left: rect.left,
  };
  return { ...fields, toJSON: (): typeof fields => ({ ...fields }) };
}

function isDisplayed(element: Element): boolean {
  if (!element.isConnected) {
    return false;
  }
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (getComputedStyle(node).display === 'none') {
      return false;
    }
  }
  return true;
}

function renderedRect(element: Element): Rect | null {
  const rect = boxes.get(element);
  return rect !== undefined && isDisplayed(element) ? rect : null;
}

function clientHeightOf(element: Element): number {
  return scrollers.get(element)?.client ?? Math.round((renderedRect(element) ?? ZERO_RECT).height);
}

function rectList(element: Element): DOMRectList {
  const rect = renderedRect(element);
  const items = rect === null ? [] : [domRect(rect)];
  return Object.assign(items, {
    item: (index: number): DOMRect | null => items[index] ?? null,
  }) as unknown as DOMRectList;
}

function offsetParentOf(element: Element): Element | null {
  const isRoot = element === document.body || element === document.documentElement;
  if (renderedRect(element) === null || isRoot || getComputedStyle(element).position === 'fixed') {
    return null;
  }
  return document.body;
}

const BOX_PROPERTIES = [
  'getBoundingClientRect',
  'getClientRects',
  'offsetWidth',
  'offsetHeight',
  'offsetTop',
  'offsetLeft',
  'clientWidth',
  'clientHeight',
  'offsetParent',
] as const;

function unboxOnReset(element: Element): void {
  if (element !== document.body && element !== document.documentElement) {
    return;
  }
  restorers.push(() => {
    boxes.delete(element);
    for (const key of BOX_PROPERTIES) {
      Reflect.deleteProperty(element, key);
    }
  });
}

const SCROLL_PROPERTIES = [
  'scrollHeight',
  'clientHeight',
  'scrollTop',
  'scrollTo',
  'scrollBy',
] as const;

function unscrollOnReset(element: Element): void {
  if (element !== document.body && element !== document.documentElement) {
    return;
  }
  restorers.push(() => {
    scrollers.delete(element);
    for (const key of SCROLL_PROPERTIES) {
      Reflect.deleteProperty(element, key);
    }
  });
}

export function setBox<T extends Element>(element: T, box: Box): T {
  if (!boxes.has(element)) {
    unboxOnReset(element);
  }
  boxes.set(element, toRect(box));
  const size = (read: (rect: Rect) => number) => (): number =>
    Math.round(read(renderedRect(element) ?? ZERO_RECT));
  Object.defineProperties(element, {
    getBoundingClientRect: {
      configurable: true,
      value: (): DOMRect => domRect(renderedRect(element) ?? ZERO_RECT),
    },
    getClientRects: { configurable: true, value: (): DOMRectList => rectList(element) },
    offsetWidth: { configurable: true, get: size(rect => rect.width) },
    offsetHeight: { configurable: true, get: size(rect => rect.height) },
    offsetTop: { configurable: true, get: size(rect => rect.top) },
    offsetLeft: { configurable: true, get: size(rect => rect.left) },
    clientWidth: { configurable: true, get: size(rect => rect.width) },
    clientHeight: { configurable: true, get: () => clientHeightOf(element) },
    offsetParent: { configurable: true, get: (): Element | null => offsetParentOf(element) },
  });
  return element;
}

export function mount<T extends HTMLElement>(
  element: T,
  box: Box,
  parent: HTMLElement = document.body
): T {
  parent.appendChild(element);
  return setBox(element, box);
}

const LAYOUT_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  'label',
  'legend',
  '[role]',
  '[contenteditable]',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'li',
  'dt',
  'dd',
  'dialog',
  'form',
  'fieldset',
].join(',');

export function layoutColumn(root: ParentNode = document.body, rowHeight = 40): void {
  let top = 10;
  for (const element of root.querySelectorAll(LAYOUT_SELECTOR)) {
    if (!boxes.has(element)) {
      setBox(element, { top });
    }
    top += rowHeight;
  }
}

export function mountHtml(html: string, autoLayout = true): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  if (autoLayout) {
    layoutColumn(host);
  }
  return host;
}

function define(target: object, key: string, descriptor: PropertyDescriptor): void {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restorers.push(() => {
    if (previous === undefined) {
      Reflect.deleteProperty(target, key);
    } else {
      Object.defineProperty(target, key, previous);
    }
  });
}

function resolveTop(
  first: ScrollToOptions | number | undefined,
  second: number | undefined,
  current: number,
  relative: boolean
): number {
  const requested = typeof first === 'object' && first !== null ? first.top : second;
  if (requested === undefined) {
    return current;
  }
  return relative ? current + requested : requested;
}

function moveTo(model: { top: number }, max: number, requested: number, notify: () => void): void {
  if (!Number.isFinite(requested)) {
    return;
  }
  const next = Math.min(Math.max(requested, 0), max);
  if (next !== model.top) {
    model.top = next;
    notify();
  }
}

function pageMax(): number {
  return Math.max(0, (pageScroll.height ?? window.innerHeight) - window.innerHeight);
}

function movePage(requested: number): void {
  moveTo(pageScroll, pageMax(), requested, () => {
    document.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

function ensurePageScroll(): void {
  if (pageScrollInstalled) {
    return;
  }
  pageScrollInstalled = true;
  const scrollTo = (first?: ScrollToOptions | number, second?: number): void =>
    movePage(resolveTop(first, second, pageScroll.top, false));
  const scrollBy = (first?: ScrollToOptions | number, second?: number): void =>
    movePage(resolveTop(first, second, pageScroll.top, true));
  const position = {
    get: (): number => pageScroll.top,
    set: (value: number): void => {
      pageScroll.top = Number(value);
    },
  };
  define(window, 'scrollY', position);
  define(window, 'pageYOffset', position);
  define(window, 'scrollTo', { value: scrollTo, writable: true });
  define(window, 'scroll', { value: scrollTo, writable: true });
  define(window, 'scrollBy', { value: scrollBy, writable: true });
  const root = document.documentElement;
  define(root, 'scrollTop', {
    get: (): number => pageScroll.top,
    set: (value: unknown): void => movePage(Number(value)),
  });
  define(root, 'scrollHeight', { get: (): number => pageScroll.height ?? window.innerHeight });
  define(root, 'clientHeight', { get: (): number => window.innerHeight });
  define(root, 'clientWidth', { get: (): number => window.innerWidth });
  define(document, 'scrollingElement', { get: (): Element => document.documentElement });
}

export function setViewport(viewport: Viewport): void {
  ensurePageScroll();
  if (viewport.width !== undefined) {
    define(window, 'innerWidth', { value: viewport.width, writable: true });
  }
  if (viewport.height !== undefined) {
    define(window, 'innerHeight', { value: viewport.height, writable: true });
  }
  if (viewport.scrollY !== undefined) {
    pageScroll.top = viewport.scrollY;
  }
  if (viewport.scrollHeight !== undefined) {
    pageScroll.height = viewport.scrollHeight;
  }
}

export function makeScrollable<T extends HTMLElement>(element: T, scrollable: Scrollable): T {
  const model: ScrollModel = {
    top: 0,
    height: scrollable.scrollHeight,
    client: scrollable.clientHeight,
  };
  unscrollOnReset(element);
  scrollers.set(element, model);
  const max = (): number => Math.max(0, model.height - clientHeightOf(element));
  const move = (requested: number): void =>
    moveTo(model, max(), requested, () => {
      element.dispatchEvent(new Event('scroll'));
    });
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: (): number => model.height },
    clientHeight: { configurable: true, get: () => clientHeightOf(element) },
    scrollTop: {
      configurable: true,
      get: (): number => model.top,
      set: (value: unknown): void => move(Number(value)),
    },
    scrollTo: {
      configurable: true,
      value: (first?: ScrollToOptions | number, second?: number): void =>
        move(resolveTop(first, second, model.top, false)),
    },
    scrollBy: {
      configurable: true,
      value: (first?: ScrollToOptions | number, second?: number): void =>
        move(resolveTop(first, second, model.top, true)),
    },
  });
  move(scrollable.scrollTop ?? 0);
  return element;
}

function isHit(element: Element, x: number, y: number): boolean {
  const rect = boxes.get(element);
  if (
    rect === undefined ||
    x < rect.left ||
    x >= rect.left + rect.width ||
    y < rect.top ||
    y >= rect.top + rect.height ||
    !isDisplayed(element)
  ) {
    return false;
  }
  const style = getComputedStyle(element);
  return style.visibility !== 'hidden' && style.pointerEvents !== 'none';
}

function pointOf(method: string, args: readonly unknown[]): readonly [number, number] {
  if (args.length < 2) {
    throw new TypeError(
      `Failed to execute '${method}' on 'Document': 2 arguments required, but only ${args.length} present.`
    );
  }
  const x = Number(args[0]);
  const y = Number(args[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError(
      `Failed to execute '${method}' on 'Document': The provided double value is non-finite.`
    );
  }
  return [x, y];
}

function hitsAt(x: number, y: number): Element[] {
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
    return [];
  }
  const hits = [...document.body.querySelectorAll('*')].filter(element => isHit(element, x, y));
  return [...hits.reverse(), document.body, document.documentElement];
}

function checkVisibility(element: Element, options: VisibilityOptions = {}): boolean {
  if (!isDisplayed(element)) {
    return false;
  }
  const checksVisibility =
    options.checkVisibilityCSS === true || options.visibilityProperty === true;
  if (checksVisibility && ['hidden', 'collapse'].includes(getComputedStyle(element).visibility)) {
    return false;
  }
  if (options.checkOpacity === true || options.opacityProperty === true) {
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      if (getComputedStyle(node).opacity === '0') {
        return false;
      }
    }
  }
  return true;
}

export function installLayoutStubs(): void {
  ensurePageScroll();
  if (stubsInstalled) {
    return;
  }
  stubsInstalled = true;
  define(Element.prototype, 'scrollIntoView', { value: (): void => undefined, writable: true });
  define(Element.prototype, 'scrollTo', {
    value: function (this: Element, first?: ScrollToOptions | number, second?: number): void {
      if (this === document.documentElement) {
        movePage(resolveTop(first, second, pageScroll.top, false));
      }
    },
    writable: true,
  });
  define(Element.prototype, 'scrollBy', {
    value: function (this: Element, first?: ScrollToOptions | number, second?: number): void {
      if (this === document.documentElement) {
        movePage(resolveTop(first, second, pageScroll.top, true));
      }
    },
    writable: true,
  });
  define(Element.prototype, 'checkVisibility', {
    value: function (this: Element, options?: VisibilityOptions): boolean {
      return checkVisibility(this, options);
    },
    writable: true,
  });
  define(document, 'elementsFromPoint', {
    value: (...args: unknown[]): Element[] => hitsAt(...pointOf('elementsFromPoint', args)),
    writable: true,
  });
  define(document, 'elementFromPoint', {
    value: (...args: unknown[]): Element | null =>
      hitsAt(...pointOf('elementFromPoint', args))[0] ?? null,
    writable: true,
  });
}

export function resetDom(): void {
  while (restorers.length > 0) {
    restorers.pop()?.();
  }
  pageScrollInstalled = false;
  stubsInstalled = false;
  pageScroll.top = 0;
  pageScroll.height = undefined;
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  for (const root of [document.documentElement, document.body]) {
    for (const name of root.getAttributeNames()) {
      root.removeAttribute(name);
    }
  }
  window.history.replaceState(null, '', '/');
}
