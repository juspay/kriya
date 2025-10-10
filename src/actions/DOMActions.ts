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

    let element = await this._findElement(options.selector, options.description);

    // If the found element is not directly clickable, try to find a clickable child
    if (!this._isElementClickable(element)) {
      const clickableChild = this._findClickableChild(element);
      if (clickableChild) {
        element = clickableChild;
      } else {
        throw new AutomationError(
          'Element is not clickable',
          'ELEMENT_NOT_FOUND',
          { selector: options.selector, description: options.description }
        );
      }
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

  private _findClickableChild(element: HTMLElement): HTMLElement | null {
    // Look for clickable child elements in order of preference
    const clickableSelectors = [
      'a[href]',           // Links with href
      'button',            // Buttons
      'input[type="button"]', // Button inputs
      'input[type="submit"]', // Submit inputs
      '[role="button"]',   // Elements with button role
      '[onclick]',         // Elements with onclick handlers
      '[data-testid*="button"]', // Test ID buttons
      '[data-button-text]' // Elements with button text data attribute
    ];

    for (const selector of clickableSelectors) {
      const clickableChild = element.querySelector(selector) as HTMLElement;
      if (clickableChild && this._isElementClickable(clickableChild)) {
        return clickableChild;
      }
    }

    // Check direct children for clickable elements
    const children = Array.from(element.children) as HTMLElement[];
    for (const child of children) {
      if (this._isElementClickable(child)) {
        // Prefer elements that are semantically clickable
        const tagName = child.tagName.toLowerCase();
        if (['a', 'button', 'input'].includes(tagName)) {
          return child;
        }
      }
    }

    // As a last resort, return any clickable child
    for (const child of children) {
      if (this._isElementClickable(child)) {
        return child;
      }
    }

    return null;
  }

  private _calculateElementScore(element: HTMLElement, description: string): number {
    let score = 0;

    const textContent = element.textContent?.toLowerCase() ?? '';
    const placeholder = (element as HTMLInputElement).placeholder?.toLowerCase() ?? '';
    const label = element.getAttribute('aria-label')?.toLowerCase() ?? '';
    const title = element.getAttribute('title')?.toLowerCase() ?? '';
    const id = element.id?.toLowerCase() ?? '';
    const className = String(element.className || '').toLowerCase();
    
    // Check data attributes for button text and other descriptive content
    const dataButtonText = element.getAttribute('data-button-text')?.toLowerCase() ?? '';
    const dataLabel = element.getAttribute('data-label')?.toLowerCase() ?? '';
    const dataTitle = element.getAttribute('data-title')?.toLowerCase() ?? '';
    const dataName = element.getAttribute('data-name')?.toLowerCase() ?? '';
    const dataTestId = element.getAttribute('data-testid')?.toLowerCase() ?? '';
    const dataButtonFor = element.getAttribute('data-button-for')?.toLowerCase() ?? '';
    const dataBreadcrumb = element.getAttribute('data-breadcrumb')?.toLowerCase() ?? '';
    const dataDesignSystem = element.getAttribute('data-design-system')?.toLowerCase() ?? '';

    // Enhanced ReScript SelectBox detection
    const isSelectBoxComponent = this._detectSelectBoxComponent(element);
    const isFormRendererField = this._detectFormRendererField(element);
    const selectBoxButtonText = this._extractSelectBoxButtonText(element);
    const formFieldName = this._extractFormFieldName(element);

    // High priority matches (exact text content)
    if (textContent.includes(description)) score += 5;
    if (dataButtonText.includes(description)) score += 5;
    if (dataBreadcrumb.includes(description)) score += 6; // High priority for breadcrumb navigation
    if (placeholder.includes(description)) score += 4;
    if (label.includes(description)) score += 4;
    if (title.includes(description)) score += 4;
    
    // Enhanced SelectBox component scoring
    if (isSelectBoxComponent) {
      score += 3; // Bonus for being a SelectBox component
      if (selectBoxButtonText.includes(description)) score += 8;
      if (selectBoxButtonText.trim() === description) score += 12;
    }
    
    // Enhanced FormRenderer field scoring
    if (isFormRendererField) {
      score += 2; // Bonus for being a FormRenderer field
      if (formFieldName.includes(description)) score += 6;
      if (formFieldName.trim() === description) score += 10;
    }
    
    // Medium priority matches (descriptive attributes)
    if (dataLabel.includes(description)) score += 3;
    if (dataTitle.includes(description)) score += 3;
    if (dataName.includes(description)) score += 3;
    if (dataTestId.includes(description)) score += 3;
    if (dataDesignSystem.includes(description) && dataDesignSystem !== 'true') score += 3; // Avoid generic 'true' values
    
    // Lower priority matches (structural identifiers)
    if (id.includes(description)) score += 2;
    if (dataButtonFor.includes(description)) score += 2;
    if (className.includes(description)) score += 1;

    // Exact matches get bonus points
    if (textContent.trim() === description) score += 10;
    if (dataButtonText.trim() === description) score += 10;
    if (dataBreadcrumb.trim() === description) score += 12; // Highest priority for exact breadcrumb matches
    if (placeholder.trim() === description) score += 8;
    if (label.trim() === description) score += 8;
    if (dataDesignSystem.trim() === description) score += 8;

    // ReScript-specific class name matching
    if (className.includes('selectbox') || className.includes('select-box')) score += 2;
    if (className.includes('dropdown') || className.includes('combobox')) score += 2;
    if (className.includes('field-renderer') || className.includes('form-field')) score += 1;

    // Penalize hidden or disabled elements
    if (element.getAttribute('aria-hidden') === 'true') score -= 5;
    if (element.style.display === 'none') score -= 5;
    if (element.style.visibility === 'hidden') score -= 5;
    if ((element as HTMLButtonElement).disabled) score -= 3;

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

  // ReScript SelectBox component detection methods
  private _detectSelectBoxComponent(element: HTMLElement): boolean {
    const className = String(element.className || '').toLowerCase();
    const tagName = element.tagName.toLowerCase();
    
    // PRIMARY: Check for Euler dashboard SelectBox data attributes (highest priority)
    if (element.hasAttribute('data-selectbox-value')) return true;
    if (element.closest('[data-selectbox-value]')) return true;
    
    // Check for button elements with Euler SelectBox patterns
    if (tagName === 'button') {
      if (element.hasAttribute('data-value') && element.querySelector('[data-button-text]')) return true;
      if (element.hasAttribute('data-value') && element.closest('[data-selectbox-value]')) return true;
    }
    
    // Check for common SelectBox patterns in ReScript components
    if (className.includes('selectbox') || className.includes('select-box')) return true;
    if (className.includes('dropdown') || className.includes('combobox')) return true;
    
    // Check for button elements that might be SelectBox triggers
    if (tagName === 'button') {
      // Look for dropdown-related classes or attributes
      if (element.getAttribute('aria-haspopup') === 'listbox') return true;
      if (element.getAttribute('role') === 'combobox') return true;
      if (className.includes('dropdown') || className.includes('select')) return true;
    }
    
    // Check if parent container has SelectBox patterns
    const parent = element.parentElement;
    if (parent) {
      const parentClass = String(parent.className || '').toLowerCase();
      if (parentClass.includes('selectbox') || parentClass.includes('select-box')) return true;
      if (parentClass.includes('dropdown') || parentClass.includes('combobox')) return true;
    }
    
    // Check for ReScript compiled class patterns (typically have BS prefix)
    if (className.includes('bs-') && (className.includes('select') || className.includes('dropdown'))) return true;
    
    return false;
  }

  private _detectFormRendererField(element: HTMLElement): boolean {
    const className = String(element.className || '').toLowerCase();
    
    // PRIMARY: Check for Euler dashboard form field data attributes (highest priority)
    if (element.hasAttribute('data-component-field-wrapper')) return true;
    if (element.closest('[data-component-field-wrapper]')) return true;
    if (element.hasAttribute('data-form-label')) return true;
    if (element.hasAttribute('data-design-system')) return true;
    
    // Check for FormRenderer field patterns
    if (className.includes('field-renderer') || className.includes('form-field')) return true;
    if (className.includes('field-container') || className.includes('form-container')) return true;
    
    // Check parent elements for FormRenderer patterns
    let current = element.parentElement;
    let depth = 0;
    while (current && depth < 5) { // Check up to 5 levels up
      const parentClass = String(current.className || '').toLowerCase();
      if (parentClass.includes('field-renderer') || parentClass.includes('form-field')) return true;
      if (parentClass.includes('field-container') || parentClass.includes('form-container')) return true;
      
      current = current.parentElement;
      depth++;
    }
    
    return false;
  }

  private _extractSelectBoxButtonText(element: HTMLElement): string {
    // Try to extract button text from Euler dashboard SelectBox components
    let text = '';
    
    // PRIMARY: Check for Euler-specific data-button-text attribute
    text = element.getAttribute('data-button-text') || '';
    if (text) return text.toLowerCase();
    
    // Look for data-button-text in children
    const buttonTextElement = element.querySelector('[data-button-text]');
    if (buttonTextElement) {
      text = buttonTextElement.getAttribute('data-button-text') || 
             buttonTextElement.textContent?.trim() || '';
      if (text) return text.toLowerCase();
    }
    
    // Check for selectbox value attribute
    text = element.getAttribute('data-selectbox-value') || '';
    if (text) return text.toLowerCase();
    
    // Look for selectbox value in parents
    const selectboxContainer = element.closest('[data-selectbox-value]');
    if (selectboxContainer) {
      text = selectboxContainer.getAttribute('data-selectbox-value') || '';
      if (text) return text.toLowerCase();
    }
    
    // Direct text content
    text = element.textContent?.trim() || '';
    if (text) return text.toLowerCase();
    
    // Check for button elements within or as the element
    if (element.tagName.toLowerCase() === 'button') {
      text = element.textContent?.trim() || '';
      if (text) return text.toLowerCase();
    }
    
    // Look for button children
    const button = element.querySelector('button');
    if (button) {
      text = button.textContent?.trim() || '';
      if (text) return text.toLowerCase();
    }
    
    // Check standard data attributes as fallback
    text = element.getAttribute('aria-label') || 
           element.getAttribute('title') || '';
    
    return text.toLowerCase();
  }

  private _extractFormFieldName(element: HTMLElement): string {
    // Extract field name from Euler dashboard FormRenderer fields
    let name = '';
    
    // PRIMARY: Check for Euler-specific data attributes
    name = element.getAttribute('data-component-field-wrapper') || '';
    if (name) return name.toLowerCase();
    
    // Look for field wrapper in parents
    const fieldWrapper = element.closest('[data-component-field-wrapper]');
    if (fieldWrapper) {
      name = fieldWrapper.getAttribute('data-component-field-wrapper') || '';
      if (name) return name.toLowerCase();
    }
    
    // Check for form label data attribute
    name = element.getAttribute('data-form-label') || '';
    if (name) return name.toLowerCase();
    
    // Look for form label in the field
    const labelElement = element.querySelector('[data-form-label]') || 
                        element.closest('[data-component-field-wrapper]')?.querySelector('[data-form-label]');
    if (labelElement) {
      name = labelElement.getAttribute('data-form-label') || 
             labelElement.textContent?.trim() || '';
      if (name) return name.toLowerCase();
    }
    
    // Standard name attribute
    name = element.getAttribute('name') || '';
    if (name) return name.toLowerCase();
    
    // Check data-name attribute
    name = element.getAttribute('data-name') || '';
    if (name) return name.toLowerCase();
    
    // Look for input elements within the field
    const input = element.querySelector('input, select, textarea');
    if (input) {
      name = input.getAttribute('name') || '';
      if (name) return name.toLowerCase();
    }
    
    // Check parent elements for name attributes
    let current = element.parentElement;
    let depth = 0;
    while (current && depth < 3) { // Check up to 3 levels up
      name = current.getAttribute('name') || current.getAttribute('data-name') || '';
      if (name) return name.toLowerCase();
      
      current = current.parentElement;
      depth++;
    }
    
    // Look for label text as fallback
    const label = element.querySelector('label');
    if (label) {
      name = label.textContent?.trim() || '';
      if (name) return name.toLowerCase();
    }
    
    return '';
  }
}
