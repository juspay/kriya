import type {
  GuideControl,
  GuideElement,
  GuideElementOperation,
  GuideObservation,
  GuideObservationOptions,
} from '@/types';

const MAX_ELEMENTS = 250;
const MAX_TEXT = 6000;
const MAX_LABEL = 160;
const MAX_PASSAGE = 1000;
const TEXT_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,dt,dd,figcaption,[role="heading"],div,span';

const ROLES = [
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemradio',
  'option',
  'combobox',
  'textbox',
  'searchbox',
  'spinbutton',
] as const;

const SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  '[contenteditable="true"]',
  ...ROLES.map(role => `[role="${role}"]`),
].join(',');

type GuideCache = {
  readonly ids: WeakMap<Element, number>;
  readonly nodes: Map<number, Element>;
  next: number;
};

const cache: GuideCache = {
  ids: new WeakMap<Element, number>(),
  nodes: new Map<number, Element>(),
  next: 1,
};

const latestTargets = new Map<string, number>();

export function resetGuideCache(): void {
  cache.nodes.clear();
  cache.next = 1;
  latestTargets.clear();
}

export function elementForGuideIndex(index: string): HTMLElement | undefined {
  const nodeId = latestTargets.get(index);
  if (nodeId === undefined) {
    return undefined;
  }
  const node = cache.nodes.get(nodeId);
  if (!(node instanceof HTMLElement) || !node.isConnected) {
    return undefined;
  }
  return node;
}

export function observePage(options: GuideObservationOptions = {}): GuideObservation {
  latestTargets.clear();
  const elements: GuideElement[] = [];
  const passages = new Set<string>();

  if (document.body !== null) {
    const selector = options.includeText === true ? `${SELECTOR},${TEXT_SELECTOR}` : SELECTOR;
    for (const node of document.querySelectorAll(selector)) {
      if (elements.length >= MAX_ELEMENTS) {
        break;
      }
      if (
        !(node instanceof HTMLElement) ||
        !isOffered(node, options) ||
        (options.allowElement !== undefined && !options.allowElement(node))
      ) {
        continue;
      }
      const index = String(elements.length + 1);
      const readableText = (node.innerText ?? node.textContent ?? '').replace(/\s+/g, ' ').trim();
      const described: GuideElement =
        roleOf(node) === null
          ? {
              index,
              role: 'text',
              label: clip(node.innerText ?? node.textContent ?? ''),
              text: readableText,
              operations: ['HIGHLIGHT'],
            }
          : describe(node, index);
      let element: GuideElement =
        options.includeText === true &&
        !described.operations.includes('HIGHLIGHT') &&
        !node.matches('input,textarea,select,[contenteditable="true"]') &&
        readableText.length >= 5 &&
        readableText.length <= MAX_PASSAGE
          ? {
              ...described,
              text: readableText,
              operations: [...described.operations, 'HIGHLIGHT'],
            }
          : described;
      if (element.operations.includes('HIGHLIGHT')) {
        const passage = (element.text ?? element.label).toLowerCase();
        if (passages.has(passage)) {
          element = {
            ...element,
            operations: element.operations.filter(operation => operation !== 'HIGHLIGHT'),
          };
          if (element.operations.length === 0) {
            continue;
          }
        } else {
          passages.add(passage);
        }
      }
      elements.push(element);
      const nodeId = identity(node);
      latestTargets.set(element.index, nodeId);
      for (const option of element.options ?? []) {
        latestTargets.set(option.index, nodeId);
      }
    }
  }

  const controls = readControls();
  const url = window.location.href;
  const title = document.title;
  const text = readVisibleText();
  const fingerprint = [
    url,
    text,
    elements
      .map(
        element =>
          `${element.index}:${element.label}:${element.text ?? ''}:${element.value ?? ''}:${element.checked ?? ''}`
      )
      .join('|'),
    controls.map(control => control.operation).join('|'),
  ].join('::');

  return {
    url,
    title,
    text,
    elements,
    controls,
    fingerprint,
  };
}

function identity(element: Element): number {
  const existing = cache.ids.get(element);
  if (existing !== undefined) {
    cache.nodes.set(existing, element);
    return existing;
  }
  const nodeId = cache.next;
  cache.next += 1;
  cache.ids.set(element, nodeId);
  cache.nodes.set(nodeId, element);
  return nodeId;
}

function isOffered(element: HTMLElement, options: GuideObservationOptions): boolean {
  if (element.closest('[aria-hidden="true"],[inert],[data-kriya-guide]') !== null) {
    return false;
  }
  const input = element instanceof HTMLInputElement ? element : null;
  if (
    input !== null &&
    (input.type === 'password' || input.type === 'file' || input.type === 'hidden')
  ) {
    return false;
  }
  if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') {
    return false;
  }
  if (!isRendered(element)) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  if (
    options.includeOffscreen !== true &&
    (rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= window.innerHeight ||
      rect.left >= window.innerWidth)
  ) {
    return false;
  }
  if (roleOf(element) === null && !(options.includeText === true && isTextCandidate(element))) {
    return false;
  }
  return options.includeOffscreen === true || !isCovered(element, rect);
}

function isRendered(element: HTMLElement): boolean {
  for (let parent: HTMLElement | null = element; parent !== null; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden' || parent.hidden) {
      return false;
    }
  }
  return true;
}

function isTextCandidate(element: HTMLElement): boolean {
  if (
    !element.matches(TEXT_SELECTOR) ||
    element.closest('input,textarea,select,[contenteditable="true"]') !== null
  ) {
    return false;
  }
  const text = (element.innerText ?? element.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < 5 || text.length > MAX_PASSAGE) {
    return false;
  }
  if (element.matches('div,span')) {
    return [...element.childNodes].some(
      node => node.nodeType === Node.TEXT_NODE && (node.textContent?.trim().length ?? 0) >= 5
    );
  }
  return true;
}

function isCovered(element: HTMLElement, rect: DOMRect): boolean {
  if (typeof document.elementFromPoint !== 'function') {
    return false;
  }
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (hit === null || hit === document.body || hit === document.documentElement) {
    return false;
  }
  return hit !== element && !element.contains(hit) && !hit.contains(element);
}

function roleOf(element: HTMLElement): string | null {
  const explicit = element.getAttribute('role');
  if (explicit !== null && (ROLES as readonly string[]).includes(explicit)) {
    return explicit;
  }
  if (element.tagName === 'BUTTON' || element.tagName === 'SUMMARY') {
    return 'button';
  }
  if (element.tagName === 'A') {
    return 'link';
  }
  if (element.tagName === 'SELECT') {
    return 'combobox';
  }
  if (element.tagName === 'TEXTAREA' || element.isContentEditable) {
    return 'textbox';
  }
  if (!(element instanceof HTMLInputElement)) {
    return null;
  }
  if (element.type === 'checkbox' || element.type === 'radio') {
    return element.type;
  }
  if (element.type === 'button' || element.type === 'submit' || element.type === 'reset') {
    return 'button';
  }
  if (element.type === 'search') {
    return 'searchbox';
  }
  if (element.type === 'number') {
    return 'spinbutton';
  }
  if (
    element.type === 'text' ||
    element.type === 'email' ||
    element.type === 'url' ||
    element.type === 'tel'
  ) {
    return 'textbox';
  }
  return null;
}

function describe(element: HTMLElement, index: string): GuideElement {
  const role = roleOf(element) ?? 'button';
  const label = clip(accessibleName(element) !== '' ? accessibleName(element) : role);
  const href = element instanceof HTMLAnchorElement ? element.getAttribute('href') : null;
  const checked =
    element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')
      ? String(element.checked)
      : element.getAttribute('aria-checked');
  const base = {
    index,
    role,
    label,
    ...(href !== null && href !== '' ? { href } : {}),
    ...(checked !== null && checked !== '' ? { checked } : {}),
  };

  if (element instanceof HTMLSelectElement) {
    const options = [...element.options]
      .filter(option => !option.disabled)
      .map((option, optionIndex) => ({
        index: `${index}:${String(optionIndex + 1)}`,
        label: clip(option.label !== '' ? option.label : option.value),
      }));
    const selected = [...element.selectedOptions].map(option => option.label).join(', ');
    return {
      ...base,
      operations: ['SELECT'],
      value: selected,
      options,
    };
  }

  const editable = isEditable(element, role);
  const operations: GuideElementOperation[] = editable ? ['CLICK', 'TYPE_TEXT'] : ['CLICK'];
  const value = readValue(element);
  return {
    ...base,
    operations,
    ...(value !== '' ? { value } : {}),
  };
}

function isEditable(element: HTMLElement, role: string): boolean {
  if (element.getAttribute('aria-readonly') === 'true') {
    return false;
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return (
      !element.readOnly && (role === 'textbox' || role === 'searchbox' || role === 'spinbutton')
    );
  }
  return element.isContentEditable;
}

function readValue(element: HTMLElement): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return clip(element.value);
  }
  if (element.isContentEditable) {
    return clip(element.innerText.trim());
  }
  return '';
}

function accessibleName(element: Element, seen: ReadonlySet<Element> = new Set<Element>()): string {
  if (seen.has(element)) {
    return '';
  }
  const nextSeen = new Set<Element>(seen);
  nextSeen.add(element);

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy !== null && labelledBy !== '') {
    const referenced = labelledBy
      .split(/\s+/)
      .map(id => {
        const target = document.getElementById(id);
        return target === null ? '' : accessibleName(target, nextSeen);
      })
      .filter(part => part !== '')
      .join(' ');
    if (referenced !== '') {
      return referenced;
    }
  }

  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel !== null && ariaLabel.trim() !== '') {
    return ariaLabel.trim();
  }

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    const labels = element.labels;
    if (labels !== null && labels.length > 0) {
      const labelText = [...labels]
        .map(label => accessibleName(label, nextSeen))
        .filter(part => part !== '')
        .join(' ');
      if (labelText !== '') {
        return labelText;
      }
    }
  }

  if (
    element instanceof HTMLInputElement &&
    element.value !== '' &&
    (element.type === 'button' || element.type === 'submit' || element.type === 'reset')
  ) {
    return element.value;
  }

  const alt = element.getAttribute('alt');
  if (alt !== null && alt.trim() !== '') {
    return alt.trim();
  }

  if (element.tagName !== 'INPUT') {
    const text = [...element.childNodes]
      .map(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          return node.textContent ?? '';
        }
        if (node instanceof Element && node.getAttribute('aria-hidden') !== 'true') {
          return accessibleName(node, nextSeen);
        }
        return '';
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text !== '') {
      return text;
    }
  }

  const title = element.getAttribute('title');
  if (title !== null && title.trim() !== '') {
    return title.trim();
  }
  const placeholder = element.getAttribute('placeholder');
  return placeholder === null ? '' : placeholder.trim();
}

function readVisibleText(): string {
  if (document.body === null) {
    return '';
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let length = 0;
  let node = walker.nextNode();
  while (node !== null && length < MAX_TEXT) {
    const value = node.textContent?.trim() ?? '';
    const parent = node.parentElement;
    if (
      value !== '' &&
      parent !== null &&
      parent.closest('script,style,noscript,[data-kriya-guide],[aria-hidden="true"],[inert]') ===
        null
    ) {
      if (isRendered(parent)) {
        parts.push(value);
        length += value.length;
      }
    }
    node = walker.nextNode();
  }
  return parts.join('\n').slice(0, MAX_TEXT);
}

function readControls(): readonly GuideControl[] {
  const controls: GuideControl[] = [];
  const root = document.documentElement;
  if (window.scrollY > 0) {
    controls.push({ operation: 'SCROLL_UP', label: 'Scroll up' });
  }
  if (window.scrollY + window.innerHeight < root.scrollHeight - 2) {
    controls.push({ operation: 'SCROLL_DOWN', label: 'Scroll down' });
  }
  controls.push({ operation: 'WAIT', label: 'Wait for the page to update' });
  return controls;
}

function clip(value: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length <= MAX_LABEL ? trimmed : trimmed.slice(0, MAX_LABEL);
}
