import type { AutomationConfig, AutomationRoot } from '@/types';

export class DOMRoot {
  private readonly _config: Pick<AutomationConfig, 'root' | 'locationProvider'>;
  private _submitListener: ((event: Event) => void) | null = null;

  constructor(config: Pick<AutomationConfig, 'root' | 'locationProvider'>) {
    this._config = config;
  }

  public get root(): AutomationRoot {
    return this._config.root ?? document;
  }

  public get document(): Document {
    const root = this.root;
    return root.nodeType === Node.DOCUMENT_NODE
      ? (root as Document)
      : (root.ownerDocument as Document);
  }

  public get container(): HTMLElement | ShadowRoot | Element {
    const root = this.root;
    return root.nodeType === Node.DOCUMENT_NODE
      ? (root as Document).body
      : (root as ShadowRoot | Element);
  }

  public get styleContainer(): HTMLElement | ShadowRoot | Element {
    const root = this.root;
    return root.nodeType === Node.DOCUMENT_NODE
      ? (root as Document).head
      : (root as ShadowRoot | Element);
  }

  public get href(): string {
    return this._config.locationProvider?.getHref() ?? window.location.href;
  }

  public get canNavigate(): boolean {
    return (
      Boolean(this._config.locationProvider) ||
      (typeof window !== 'undefined' && Boolean(window.location))
    );
  }

  public navigate(url: string): void {
    window.location.href = url;
  }

  public resolveUrl(href: string): string {
    return new URL(href, this._config.locationProvider ? this.href : window.location.origin).href;
  }

  public get title(): string {
    return this._config.locationProvider?.getTitle?.() ?? this.document.title;
  }

  public get eventOptions(): EventInit {
    return this._config.root ? { composed: true } : {};
  }

  public contains(node: Node): boolean {
    return this.root.contains(node);
  }

  public querySelector<K extends keyof HTMLElementTagNameMap>(
    selector: K
  ): HTMLElementTagNameMap[K] | null;
  public querySelector<E extends Element = Element>(selector: string): E | null;
  public querySelector(selector: string): Element | null {
    const root = this.root;
    if (root.nodeType === Node.ELEMENT_NODE && (root as Element).matches(selector)) {
      return root as Element;
    }
    return root.querySelector(selector);
  }

  public querySelectorAll<K extends keyof HTMLElementTagNameMap>(
    selector: K
  ): HTMLElementTagNameMap[K][];
  public querySelectorAll<E extends Element = Element>(selector: string): E[];
  public querySelectorAll(selector: string): Element[] {
    const root = this.root;
    const elements = Array.from(root.querySelectorAll(selector));
    if (root.nodeType === Node.ELEMENT_NODE && (root as Element).matches(selector)) {
      elements.unshift(root as Element);
    }
    return elements;
  }

  public getElementById(id: string): HTMLElement | null {
    const root = this.root;
    if (root.nodeType === Node.DOCUMENT_NODE || root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      return (root as Document | ShadowRoot).getElementById(id) as HTMLElement | null;
    }
    return this.querySelectorAll<HTMLElement>('[id]').find(element => element.id === id) ?? null;
  }

  public parentElement(element: Element): HTMLElement | null {
    if (!this._config.root) {
      return element.parentElement;
    }
    if (element === this.root) {
      return null;
    }
    if (element.getRootNode() !== this.root.getRootNode()) {
      return null;
    }
    const parent = element.parentElement;
    if (parent && this.contains(parent)) {
      return parent;
    }
    return null;
  }

  public closest(element: Element, selector: string): HTMLElement | null {
    if (!this._config.root) {
      return element.closest(selector);
    }
    let current: Element | null = element;
    while (current && this.contains(current)) {
      if (current.matches(selector)) {
        return current as HTMLElement;
      }
      current = this.parentElement(current);
    }
    return null;
  }

  public get activeElement(): Element | null {
    const root = this.root;
    const tree = root.getRootNode() as Document | ShadowRoot;
    const active = tree.activeElement;
    return active && this.contains(active) ? active : null;
  }

  public createElement<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
    return this.document.createElement(tag);
  }

  public createTreeWalker(): TreeWalker {
    return this.document.createTreeWalker(this.container, NodeFilter.SHOW_ELEMENT, null);
  }

  public screenshotElement(fullPage: boolean): HTMLElement {
    const root = this.root;
    if (root.nodeType === Node.DOCUMENT_NODE) {
      return fullPage ? (root as Document).body : (root as Document).documentElement;
    }
    if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      return (root as ShadowRoot).host as HTMLElement;
    }
    return root as HTMLElement;
  }

  public initialize(): void {
    if (!this._config.root || this._submitListener) {
      return;
    }
    this._submitListener = (event: Event): void => {
      const target = event.target as Element | null;
      if (
        event.composed ||
        !target ||
        target.nodeType !== Node.ELEMENT_NODE ||
        target.tagName.toLowerCase() !== 'form' ||
        target.getRootNode().nodeType !== Node.DOCUMENT_FRAGMENT_NODE
      ) {
        return;
      }
      event.stopImmediatePropagation();
      const submitted = target.dispatchEvent(
        new SubmitEvent('submit', {
          bubbles: true,
          cancelable: true,
          composed: true,
          submitter: (event as SubmitEvent).submitter,
        })
      );
      if (!submitted) {
        event.preventDefault();
      }
    };
    this.root.addEventListener('submit', this._submitListener, true);
  }

  public dispose(): void {
    if (this._submitListener) {
      this.root.removeEventListener('submit', this._submitListener, true);
      this._submitListener = null;
    }
  }
}
