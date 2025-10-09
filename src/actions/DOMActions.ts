import type {
  AutomationConfig,
  ClickOptions,
  FillOptions,
  NavigationOptions,
  WaitOptions,
} from '@/types';
import { AutomationError } from '@/types';

export class DOMActions {
  private readonly _config: AutomationConfig;
  private _initialized: boolean;

  constructor(config: AutomationConfig) {
    this._config = config;
    this._initialized = false;
  }

  public initialize(): void {
    this._initialized = true;
  }

  public async navigate(options: NavigationOptions): Promise<void> {
    this._ensureInitialized();

    if (typeof window === 'undefined' || !window.location) {
      throw new AutomationError(
        'Navigation not supported in this environment',
        'BROWSER_NOT_SUPPORTED'
      );
    }

    try {
      if (options.waitForLoad) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new AutomationError(
              `Navigation timeout after ${options.timeout ?? this._config.timeout}ms`,
              'EXECUTION_TIMEOUT'
            ));
          }, options.timeout ?? this._config.timeout);

          const handleLoad = (): void => {
            clearTimeout(timeout);
            window.removeEventListener('load', handleLoad);
            resolve();
          };

          window.addEventListener('load', handleLoad);
          window.location.href = options.url;
        });
      } else {
        window.location.href = options.url;
      }
    } catch (error) {
      throw new AutomationError(
        `Navigation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'NETWORK_ERROR',
        { url: options.url, originalError: error }
      );
    }
  }

  public async click(options: ClickOptions): Promise<void> {
    this._ensureInitialized();

    const element = await this._findElement(options.selector, options.description);

    if (!this._isElementClickable(element)) {
      throw new AutomationError(
        'Element is not clickable',
        'ELEMENT_NOT_FOUND',
        { selector: options.selector, description: options.description }
      );
    }

    try {
      if (options.position) {
        this._clickAtPosition(element, options.position, options.button, options.clickCount);
      } else {
        this._clickElement(element, options.button, options.clickCount);
      }
    } catch (error) {
      throw new AutomationError(
        `Click failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'EXECUTION_FAILED',
        { selector: options.selector, originalError: error }
      );
    }
  }

  public async fill(options: FillOptions): Promise<void> {
    this._ensureInitialized();

    const element = await this._findElement(options.selector, options.description);

    if (!this._isElementFillable(element)) {
      throw new AutomationError(
        'Element is not fillable',
        'ELEMENT_NOT_FOUND',
        { selector: options.selector, description: options.description }
      );
    }

    try {
      const inputElement = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

      if (options.clearFirst) {
        this._clearElement(inputElement);
      }

      this._fillElement(inputElement, options.value, options.triggerEvents);
    } catch (error) {
      throw new AutomationError(
        `Fill failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'EXECUTION_FAILED',
        { selector: options.selector, value: options.value, originalError: error }
      );
    }
  }

  public async wait(options: WaitOptions): Promise<void> {
    this._ensureInitialized();

    if (options.duration) {
      await new Promise(resolve => setTimeout(resolve, options.duration));
      return;
    }

    if (options.selector && options.condition) {
      await this._waitForCondition(options.selector, options.condition, options.timeout);
      return;
    }

    throw new AutomationError(
      'Wait action requires either duration or selector with condition',
      'VALIDATION_FAILED',
      { options }
    );
  }

  public dispose(): void {
    this._initialized = false;
  }

  private _ensureInitialized(): void {
    if (!this._initialized) {
      throw new AutomationError(
        'DOMActions must be initialized before use',
        'INVALID_CONFIGURATION'
      );
    }
  }

  private async _findElement(
    selector?: string, 
    description?: string
  ): Promise<HTMLElement> {
    if (selector) {
      const element = document.querySelector(selector) as HTMLElement;
      if (element) {
        return element;
      }
    }

    if (description) {
      const element = this._findElementByDescription(description);
      if (element) {
        return element;
      }
    }

    throw new AutomationError(
      'Element not found',
      'ELEMENT_NOT_FOUND',
      { selector, description }
    );
  }

  private _findElementByDescription(description: string): HTMLElement | null {
    const lowerDescription = description.toLowerCase();
    const elements = Array.from(document.querySelectorAll('*')) as HTMLElement[];

    const scores = elements.map(element => ({
      element,
      score: this._calculateElementScore(element, lowerDescription),
    }));

    scores.sort((a, b) => b.score - a.score);

    const bestMatch = scores[0];
    return bestMatch && bestMatch.score > 0 ? bestMatch.element : null;
  }

  private _calculateElementScore(element: HTMLElement, description: string): number {
    let score = 0;

    const textContent = element.textContent?.toLowerCase() ?? '';
    const placeholder = (element as HTMLInputElement).placeholder?.toLowerCase() ?? '';
    const label = element.getAttribute('aria-label')?.toLowerCase() ?? '';
    const id = element.id?.toLowerCase() ?? '';
    const className = String(element.className || '').toLowerCase();

    if (textContent.includes(description)) score += 3;
    if (placeholder.includes(description)) score += 3;
    if (label.includes(description)) score += 3;
    if (id.includes(description)) score += 2;
    if (className.includes(description)) score += 1;

    if (element.getAttribute('aria-hidden') === 'true') score -= 5;
    if (element.style.display === 'none') score -= 5;
    if (element.style.visibility === 'hidden') score -= 5;

    return score;
  }

  private _isElementClickable(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.pointerEvents === 'none') return false;

    return true;
  }

  private _isElementFillable(element: HTMLElement): boolean {
    const tagName = element.tagName.toLowerCase();
    const type = (element as HTMLInputElement).type?.toLowerCase();

    if (tagName === 'input') {
      const fillableTypes = ['text', 'email', 'password', 'tel', 'url', 'search', 'number'];
      return fillableTypes.includes(type ?? 'text');
    }

    if (tagName === 'textarea') return true;
    if (tagName === 'select') return true;

    return element.contentEditable === 'true';
  }

  private _clickElement(
    element: HTMLElement, 
    button: ClickOptions['button'], 
    clickCount: number
  ): void {
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      button: button === 'left' ? 0 : button === 'right' ? 2 : 1,
      detail: clickCount,
    };

    for (let i = 0; i < clickCount; i++) {
      element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
      element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
      element.dispatchEvent(new MouseEvent('click', eventOptions));
    }

    element.focus();
  }

  private _clickAtPosition(
    element: HTMLElement,
    position: { x: number; y: number },
    button: ClickOptions['button'],
    clickCount: number
  ): void {
    const rect = element.getBoundingClientRect();
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      button: button === 'left' ? 0 : button === 'right' ? 2 : 1,
      detail: clickCount,
      clientX: rect.left + position.x,
      clientY: rect.top + position.y,
    };

    for (let i = 0; i < clickCount; i++) {
      element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
      element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
      element.dispatchEvent(new MouseEvent('click', eventOptions));
    }
  }

  private _clearElement(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): void {
    if (element.tagName.toLowerCase() === 'select') {
      (element as HTMLSelectElement).selectedIndex = 0;
    } else {
      element.value = '';
    }

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  private _fillElement(
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    value: string,
    triggerEvents: boolean
  ): void {
    if (element.tagName.toLowerCase() === 'select') {
      const selectElement = element as HTMLSelectElement;
      const option = Array.from(selectElement.options).find(opt => 
        opt.value === value || opt.textContent === value
      );
      
      if (option) {
        selectElement.selectedIndex = option.index;
      } else {
        throw new AutomationError(
          `Option not found in select: ${value}`,
          'ELEMENT_NOT_FOUND'
        );
      }
    } else {
      element.value = value;
    }

    if (triggerEvents) {
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('blur', { bubbles: true }));
    }
  }

  private async _waitForCondition(
    selector: string,
    condition: WaitOptions['condition'],
    timeout?: number
  ): Promise<void> {
    const maxWait = timeout ?? this._config.timeout;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      const element = document.querySelector(selector) as HTMLElement;
      
      if (this._checkCondition(element, condition)) {
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new AutomationError(
      `Wait condition not met within ${maxWait}ms`,
      'EXECUTION_TIMEOUT',
      { selector, condition }
    );
  }

  private _checkCondition(element: HTMLElement | null, condition: WaitOptions['condition']): boolean {
    if (!element && (condition === 'hidden' || condition === 'disabled')) {
      return true;
    }

    if (!element) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const isVisible = style.display !== 'none' && style.visibility !== 'hidden';
    const isEnabled = !(element as HTMLInputElement).disabled;

    switch (condition) {
      case 'visible':
        return isVisible;
      case 'hidden':
        return !isVisible;
      case 'enabled':
        return isEnabled;
      case 'disabled':
        return !isEnabled;
      default:
        return false;
    }
  }
}
