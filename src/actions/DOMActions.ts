import type {
  AutomationConfig,
  ClickOptions,
  FillOptions,
  NavigationOptions,
  WaitOptions,
  PressOptions,
} from '@/types';
import { AutomationError } from '@/types';

export class DOMActions {
  private readonly _config: AutomationConfig;
  private _initialized: boolean;

  constructor(config: AutomationConfig) {
    this._config = config;
    this._initialized = false;
  }

  /**
   * Debug log gated on `AutomationConfig.debugMode`. Library code must not
   * emit to consumers' devtools on every action.
   */
  private forcelog(...args: readonly unknown[]): void {
    if (!this._config.debugMode) {
      return;
    }
    console.info('🔍 KRIYA-ENHANCED:', ...args);
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
            reject(
              new AutomationError(
                `Navigation timeout after ${options.timeout ?? this._config.timeout}ms`,
                'EXECUTION_TIMEOUT'
              )
            );
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

    this.forcelog('[KRIYA DEBUG] Click attempt - Found element:', element);
    this.forcelog(`[KRIYA DEBUG] Click attempt - Element tag: ${element.tagName}`);
    this.forcelog(`[KRIYA DEBUG] Click attempt - Element href: ${element.getAttribute('href')}`);
    this.forcelog(
      `[KRIYA DEBUG] Click attempt - Element clickable: ${this._isElementClickable(element)}`
    );

    // If the found element is not directly clickable, try to find a clickable child or parent
    if (!this._isElementClickable(element)) {
      this.forcelog('[KRIYA DEBUG] Element not directly clickable, looking for alternatives...');
      // First try to find a clickable child
      const clickableChild = this._findClickableChild(element);
      if (clickableChild) {
        this.forcelog('[KRIYA DEBUG] Found clickable child:', clickableChild);
        element = clickableChild;
      } else {
        // If no clickable child, try to find a clickable parent
        const clickableParent = this._findClickableParent(element);
        if (clickableParent) {
          this.forcelog('[KRIYA DEBUG] Found clickable parent:', clickableParent);
          element = clickableParent;
        } else {
          this.forcelog('[KRIYA DEBUG] No clickable parent or child found');
          throw new AutomationError(
            'Element is not clickable and no clickable parent or child found',
            'ELEMENT_NOT_FOUND',
            { selector: options.selector, description: options.description }
          );
        }
      }
    }

    this.forcelog('[KRIYA DEBUG] About to click element:', element);
    this.forcelog('[KRIYA DEBUG] Click options:', {
      position: options.position,
      button: options.button || 'left',
      clickCount: options.clickCount || 1,
    });

    try {
      // Scroll element into view first
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Wait a small moment for scroll to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      if (options.position) {
        this.forcelog('[KRIYA DEBUG] Clicking at position:', options.position);
        this._clickAtPosition(element, options.position, options.button, options.clickCount);
      } else {
        this.forcelog('[KRIYA DEBUG] Clicking element directly');
        this._clickElement(element, options.button, options.clickCount);
      }

      this.forcelog('[KRIYA DEBUG] Click events dispatched successfully');
    } catch (error) {
      this.forcelog('[KRIYA DEBUG] Click failed with error:', error);
      throw new AutomationError(
        `Click failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'EXECUTION_FAILED',
        { selector: options.selector, originalError: error }
      );
    }
  }

  public async fill(options: FillOptions): Promise<void> {
    this._ensureInitialized();

    this.forcelog(`[KRIYA DEBUG] Fill attempt - Description: "${options.description}"`);
    this.forcelog(`[KRIYA DEBUG] Fill attempt - Value to fill: "${options.value}"`);

    // For fill, prioritize finding input elements
    const searchTarget = (options.selector || options.description || '').toString();
    let element: HTMLElement | null = await this._findElementByText(searchTarget, true);

    this.forcelog('[KRIYA DEBUG] Fill attempt - Found element:', element);
    this.forcelog(`[KRIYA DEBUG] Fill attempt - Element tag: ${element?.tagName}`);
    this.forcelog(
      `[KRIYA DEBUG] Fill attempt - Element type: ${(element as HTMLInputElement)?.type}`
    );
    this.forcelog(
      `[KRIYA DEBUG] Fill attempt - Is fillable: ${element ? this._isElementFillable(element) : 'NO ELEMENT'}`
    );

    // If element is not fillable, try to find the associated input from label
    if (!element || !this._isElementFillable(element)) {
      this.forcelog(
        '[KRIYA DEBUG] Element not fillable, trying to find associated input from label...'
      );

      // Try to find the input associated with this label
      const labelElement = element
        ? element.tagName.toLowerCase() === 'label'
          ? element
          : element.closest('label')
        : null;
      if (labelElement) {
        const forAttr = labelElement.getAttribute('for');
        if (forAttr) {
          const associatedInput = document.getElementById(forAttr) as HTMLElement;
          if (associatedInput && this._isElementFillable(associatedInput)) {
            this.forcelog(
              // eslint-disable-next-line quotes
              "[KRIYA DEBUG] Found associated input via label 'for' attribute:",
              associatedInput
            );
            element = associatedInput;
          }
        }

        // If still not found, look for input inside label
        if (!element || !this._isElementFillable(element)) {
          const inputInside = labelElement.querySelector('input, textarea, select') as HTMLElement;
          if (inputInside && this._isElementFillable(inputInside)) {
            this.forcelog('[KRIYA DEBUG] Found input inside label:', inputInside);
            element = inputInside;
          }
        }
      }

      // Try to find sibling input element
      if (!element || !this._isElementFillable(element)) {
        const siblingInput = element?.nextElementSibling as HTMLElement;
        if (siblingInput && this._isElementFillable(siblingInput)) {
          this.forcelog('[KRIYA DEBUG] Found sibling input:', siblingInput);
          element = siblingInput;
        }
      }
    }

    // FINAL CHECK: If still not fillable, try to find any input in the same container/form
    if (!element || !this._isElementFillable(element)) {
      this.forcelog(
        '[KRIYA DEBUG] Element still not fillable, searching for input in surrounding context...'
      );

      // Look for input in parent elements (up to 3 levels)
      let parent = element?.parentElement;
      for (let i = 0; i < 3 && parent && element && !this._isElementFillable(element); i++) {
        const inputs = parent.querySelectorAll('input, textarea, select');
        for (const input of inputs) {
          if (this._isElementFillable(input as HTMLElement)) {
            this.forcelog('[KRIYA DEBUG] Found fillable input in parent context:', input);
            element = input as HTMLElement;
            break;
          }
        }
        parent = parent.parentElement;
      }
    }

    if (!element || !this._isElementFillable(element)) {
      this.forcelog('[KRIYA DEBUG] Fill failed - Element is not fillable:', element);
      throw new AutomationError('Element is not fillable', 'ELEMENT_NOT_FOUND', {
        selector: options.selector,
        description: options.description,
      });
    }

    try {
      const inputElement = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

      this.forcelog('[KRIYA DEBUG] Filling element:', inputElement);
      this.forcelog(`[KRIYA DEBUG] Current value: "${inputElement.value}"`);

      if (options.clearFirst) {
        this._clearElement(inputElement);
      }

      this._fillElement(inputElement, options.value, options.triggerEvents);

      this.forcelog(`[KRIYA DEBUG] Fill completed - New value: "${inputElement.value}"`);
    } catch (error) {
      this.forcelog('[KRIYA DEBUG] Fill failed with error:', error);
      throw new AutomationError(
        `Fill failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'EXECUTION_FAILED',
        {
          selector: options.selector,
          value: options.value,
          originalError: error,
        }
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

  public async press(options: PressOptions): Promise<void> {
    this._ensureInitialized();

    const { key, selector, description } = options;

    // Find the target element
    let element: HTMLElement | null = null;
    if (selector) {
      element = document.querySelector(selector) as HTMLElement;
    } else if (description) {
      element = await this._findElementByText(description, true);
      if (!element) {
        element = this._findElementByDescription(description);
      }
    }

    // If no specific element, try document.activeElement — but only if it's a real input,
    // not body (which is the fallback after blur fires during fill)
    if (!element) {
      const active = document.activeElement as HTMLElement;
      if (active && active !== document.body && this._isElementFillable(active)) {
        element = active;
      } else {
        // Last resort: find the most recently interacted visible input
        const inputs = Array.from(
          document.querySelectorAll('input:not([type="hidden"]), textarea')
        ) as HTMLElement[];
        element =
          inputs.find(el => {
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
          }) || document.body;
      }
    }

    const targetElement = element as HTMLElement;

    this.forcelog(`[KRIYA] Pressing key "${key}" on element:`, targetElement);

    // Focus the resolved element before dispatching key events
    if (targetElement && targetElement.focus) {
      targetElement.focus();
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Create and dispatch keyboard events
    const keydownEvent = new KeyboardEvent('keydown', {
      key,
      code: key === 'Enter' ? 'Enter' : key,
      keyCode: key === 'Enter' ? 13 : key.charCodeAt(0),
      which: key === 'Enter' ? 13 : key.charCodeAt(0),
      bubbles: true,
      cancelable: true,
    });

    const keypressEvent = new KeyboardEvent('keypress', {
      key,
      code: key === 'Enter' ? 'Enter' : key,
      keyCode: key === 'Enter' ? 13 : key.charCodeAt(0),
      which: key === 'Enter' ? 13 : key.charCodeAt(0),
      bubbles: true,
      cancelable: true,
    });

    const keyupEvent = new KeyboardEvent('keyup', {
      key,
      code: key === 'Enter' ? 'Enter' : key,
      keyCode: key === 'Enter' ? 13 : key.charCodeAt(0),
      which: key === 'Enter' ? 13 : key.charCodeAt(0),
      bubbles: true,
      cancelable: true,
    });

    targetElement.dispatchEvent(keydownEvent);
    targetElement.dispatchEvent(keypressEvent);
    targetElement.dispatchEvent(keyupEvent);

    this.forcelog(`[KRIYA] Key "${key}" pressed successfully`);
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

  private async _findElement(selector?: string, description?: string): Promise<HTMLElement> {
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

    throw new AutomationError('Element not found', 'ELEMENT_NOT_FOUND', {
      selector,
      description,
    });
  }

  private _findElementByDescription(description: string): HTMLElement | null {
    const lowerDescription = description.toLowerCase();
    const elements = Array.from(document.querySelectorAll('*')) as HTMLElement[];

    const scores = elements.map(element => ({
      element,
      score: this._calculateElementScore(element, lowerDescription),
    }));

    scores.sort((a, b) => b.score - a.score);

    // DEBUG: Log top 10 scoring elements for debugging
    if (this._config.debugMode) {
      this.forcelog(`[KRIYA DEBUG] Searching for: "${description}"`);
      this.forcelog('[KRIYA DEBUG] Top 10 scoring elements:');
      scores.slice(0, 10).forEach((item, index) => {
        const { element, score } = item;
        const tagName = element.tagName.toLowerCase();
        const text = element.textContent?.trim().substring(0, 100) || '';
        const href = element.getAttribute('href') || '';
        const clickable = this._isElementClickable(element);
        const dataDesignSystem = element.getAttribute('data-design-system') || '';
        const className = element.className || '';

        this.forcelog(
          `  ${index + 1}. Score: ${score} | Tag: ${tagName} | Clickable: ${clickable} | Text: "${text}" | Href: "${href}" | data-design-system: "${dataDesignSystem}" | class: "${className.substring(0, 50)}"`
        );
      });
    }

    // DEBUG: Log additional info for YouTube-specific debugging
    if (this._config.debugMode && lowerDescription.includes('youtube')) {
      this.forcelog('[KRIYA DEBUG] YouTube-specific analysis:');

      // Look for elements with YouTube in href
      const youtubeLinks = Array.from(
        document.querySelectorAll('a[href*="youtube"]')
      ) as HTMLElement[];
      this.forcelog(`[KRIYA DEBUG] Found ${youtubeLinks.length} elements with YouTube in href:`);
      youtubeLinks.forEach((link, index) => {
        const score = this._calculateElementScore(link, lowerDescription);
        const clickable = this._isElementClickable(link);
        this.forcelog(
          `  YouTube Link ${index + 1}: Score: ${score} | Clickable: ${clickable} | Text: "${link.textContent?.trim()}" | Href: "${link.getAttribute('href')}"`
        );
      });

      // Look for elements with data-design-system
      const designSystemElements = Array.from(
        document.querySelectorAll('[data-design-system]')
      ) as HTMLElement[];
      this.forcelog(
        `[KRIYA DEBUG] Found ${designSystemElements.length} elements with data-design-system:`
      );
      designSystemElements.slice(0, 5).forEach((element, index) => {
        const score = this._calculateElementScore(element, lowerDescription);
        const clickable = this._isElementClickable(element);
        const text = element.textContent?.trim() || '';
        this.forcelog(
          `  Design System ${index + 1}: Score: ${score} | Clickable: ${clickable} | Text: "${text.substring(0, 50)}" | data-design-system: "${element.getAttribute('data-design-system')}"`
        );
      });
    }

    const bestMatch = scores[0];

    // DEBUG: Log the selected element
    if (this._config.debugMode && bestMatch && bestMatch.score > 0) {
      this.forcelog('[KRIYA DEBUG] Selected element:', bestMatch.element);
      this.forcelog(`[KRIYA DEBUG] Selected element score: ${bestMatch.score}`);
      this.forcelog(
        `[KRIYA DEBUG] Selected element clickable: ${this._isElementClickable(bestMatch.element)}`
      );
    } else if (this._config.debugMode) {
      this.forcelog('[KRIYA DEBUG] No element found with score > 0');
    }

    // Require minimum score threshold to avoid clicking wrong elements
    // Low-scoring matches (e.g., logo link with score < 10) indicate poor match
    const MIN_SCORE_THRESHOLD = 10;
    if (!bestMatch || bestMatch.score < MIN_SCORE_THRESHOLD) {
      if (this._config.debugMode) {
        this.forcelog(
          `[KRIYA DEBUG] No element found with score >= ${MIN_SCORE_THRESHOLD}. Best score was: ${bestMatch?.score || 0}`
        );
      }
      return null;
    }
    return bestMatch.element;
  }

  private _findClickableChild(element: HTMLElement): HTMLElement | null {
    // Look for clickable child elements in order of preference
    const clickableSelectors = [
      'a[href]', // Links with href (highest priority)
      'button', // Buttons
      'input[type="button"]', // Button inputs
      'input[type="submit"]', // Submit inputs
      '[role="button"]', // Elements with button role
      '[onclick]', // Elements with onclick handlers
      '[data-testid*="button"]', // Test ID buttons
      '[data-button-text]', // Elements with button text data attribute
    ];

    // First, try to find direct children that match selectors
    for (const selector of clickableSelectors) {
      const clickableChild = element.querySelector(selector) as HTMLElement;
      if (clickableChild && this._isElementClickable(clickableChild)) {
        // Additional check: ensure the clickable child is a direct or close descendant
        return clickableChild;
      }
    }

    // Check direct children for clickable elements (prioritize semantic elements)
    const children = Array.from(element.children) as HTMLElement[];
    for (const child of children) {
      if (this._isElementClickable(child)) {
        const tagName = child.tagName.toLowerCase();
        // Prioritize semantically clickable elements
        if (tagName === 'a' && child.getAttribute('href')) {
          return child;
        }
        if (tagName === 'button') {
          return child;
        }
        if (
          tagName === 'input' &&
          ['button', 'submit'].includes((child as HTMLInputElement).type)
        ) {
          return child;
        }
      }
    }

    // Recursively check children of children (up to 2 levels deep)
    for (const child of children) {
      const grandchildren = Array.from(child.children) as HTMLElement[];
      for (const grandchild of grandchildren) {
        if (this._isElementClickable(grandchild)) {
          const tagName = grandchild.tagName.toLowerCase();
          if (tagName === 'a' && grandchild.getAttribute('href')) {
            return grandchild;
          }
          if (tagName === 'button') {
            return grandchild;
          }
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

  private _findClickableParent(element: HTMLElement): HTMLElement | null {
    // Look for clickable parent elements up the DOM tree (up to 5 levels)
    let current = element.parentElement;
    let depth = 0;
    const maxDepth = 5;

    while (current && depth < maxDepth) {
      if (this._isElementClickable(current)) {
        const tagName = current.tagName.toLowerCase();

        // Prioritize semantically clickable elements
        if (tagName === 'a' && current.getAttribute('href')) {
          return current;
        }
        if (tagName === 'button') {
          return current;
        }
        if (current.getAttribute('role') === 'button') {
          return current;
        }
        if (current.getAttribute('onclick')) {
          return current;
        }

        // Return any clickable parent as fallback
        return current;
      }

      current = current.parentElement;
      depth++;
    }

    return null;
  }

  private _calculateElementScore(element: HTMLElement, description: string): number {
    let score = 0;

    // Enhanced text content processing - handle whitespace and invisible characters
    const rawTextContent = element.textContent ?? '';
    const textContent = rawTextContent.toLowerCase().trim().replace(/\s+/g, ' '); // Normalize whitespace
    const placeholder = (element as HTMLInputElement).placeholder?.toLowerCase().trim() ?? '';
    const label = element.getAttribute('aria-label')?.toLowerCase().trim() ?? '';
    const title = element.getAttribute('title')?.toLowerCase().trim() ?? '';
    const id = element.id?.toLowerCase() ?? '';
    const className = String(element.className || '').toLowerCase();

    // Normalize the description as well - strip asterisks first, then normalize whitespace
    const normalizedDescription = description
      .toLowerCase()
      .trim()
      .replace(/\*/g, '')
      .replace(/\s+/g, ' ');

    // Check data attributes for button text and other descriptive content
    const dataButtonText = element.getAttribute('data-button-text')?.toLowerCase() ?? '';
    const dataLabel = element.getAttribute('data-label')?.toLowerCase() ?? '';
    const dataTitle = element.getAttribute('data-title')?.toLowerCase() ?? '';
    const dataName = element.getAttribute('data-name')?.toLowerCase() ?? '';
    const dataTestId = element.getAttribute('data-testid')?.toLowerCase() ?? '';
    const dataButtonFor = element.getAttribute('data-button-for')?.toLowerCase() ?? '';
    const dataBreadcrumb = element.getAttribute('data-breadcrumb')?.toLowerCase() ?? '';
    const dataDesignSystem = element.getAttribute('data-design-system')?.toLowerCase() ?? '';
    const dataNumberinput = element.getAttribute('data-numberinput')?.toLowerCase() ?? '';
    const dataField = element.getAttribute('data-field')?.toLowerCase() ?? '';

    // DEBUG: Log text comparison for problematic elements
    if (
      this._config.debugMode &&
      (textContent.includes('bulk') || textContent.includes('operation'))
    ) {
      this.forcelog(`[KRIYA DEBUG] Text comparison for ${element.tagName}:`);
      this.forcelog(`  Raw text: "${rawTextContent}"`);
      this.forcelog(`  Normalized text: "${textContent}"`);
      this.forcelog(`  Target: "${normalizedDescription}"`);
      this.forcelog(`  Exact match: ${textContent === normalizedDescription}`);
      this.forcelog(`  Contains match: ${textContent.includes(normalizedDescription)}`);
      this.forcelog('  Element: ', element);
    }

    // Enhanced ReScript SelectBox detection
    const isSelectBoxComponent = this._detectSelectBoxComponent(element);
    const isFormRendererField = this._detectFormRendererField(element);
    const selectBoxButtonText = this._extractSelectBoxButtonText(element);
    const formFieldName = this._extractFormFieldName(element);

    // NESTED ELEMENT HANDLING: Check if this element contains the target text in child elements
    // This is crucial for complex nested structures like your Bulk Operations element
    let hasNestedTextMatch = false;
    if (textContent.includes(description)) {
      // Check if the text match comes from a direct child vs deeply nested
      const directChildrenText = Array.from(element.children)
        .map(child => child.textContent?.toLowerCase() ?? '')
        .join(' ');

      if (directChildrenText.includes(description)) {
        hasNestedTextMatch = true;
      }
    }

    // HIGHEST Priority: URL + Text Content Combination (like YouTube links)
    const href = element.getAttribute('href')?.toLowerCase() ?? '';
    if (href && textContent.includes(normalizedDescription)) {
      // Check if the href contains the same text as the description (case insensitive)
      if (href.includes(normalizedDescription)) {
        score += 25; // Very high score for URL + text content match
      } else {
        score += 18; // High score for any URL with matching text content
      }
    }

    // HIGHEST Priority: Exact breadcrumb matches (navigation elements)
    if (dataBreadcrumb.trim() === normalizedDescription) {
      score += 20;
    } // Highest priority for exact breadcrumb matches
    if (dataBreadcrumb.includes(normalizedDescription)) {
      score += 15;
    } // High priority for breadcrumb navigation

    // High priority matches (exact text content) - using normalized text
    if (textContent === normalizedDescription) {
      score += 12;
    }
    if (textContent.includes(normalizedDescription)) {
      // Boost score for clickable elements that contain the text (like your <a> element)
      const tagName = element.tagName.toLowerCase();
      if ((tagName === 'a' && element.getAttribute('href')) || tagName === 'button') {
        score += 10; // Higher score for clickable elements containing the text
      } else {
        score += 8;
      }
    }

    // FALLBACK: Check if any individual words from description match
    const descriptionWords = normalizedDescription.split(' ');
    const textWords = textContent.split(' ');
    const matchingWords = descriptionWords.filter(word =>
      textWords.some(textWord => textWord.includes(word))
    );

    if (matchingWords.length === descriptionWords.length && descriptionWords.length > 1) {
      // All words from description found in text
      const tagName = element.tagName.toLowerCase();
      if ((tagName === 'a' && element.getAttribute('href')) || tagName === 'button') {
        score += 9; // High score for word-based match in clickable elements
      } else {
        score += 6; // Lower score for word-based match in non-clickable elements
      }
    } else if (matchingWords.length > 0) {
      // Partial word match
      score += Math.min(matchingWords.length * 2, 5);
    }

    if (dataButtonText.trim() === normalizedDescription) {
      score += 12;
    }
    if (dataButtonText.includes(normalizedDescription)) {
      score += 8;
    }

    // Exact matches for other descriptive attributes
    if (placeholder === normalizedDescription) {
      score += 10;
    }
    if (label === normalizedDescription) {
      score += 10;
    }
    if (title === normalizedDescription) {
      score += 10;
    }
    if (dataDesignSystem.trim() === normalizedDescription && dataDesignSystem !== 'true') {
      score += 10;
    }

    // Partial matches for descriptive attributes
    if (placeholder.includes(normalizedDescription)) {
      score += 6;
    }
    if (label.includes(normalizedDescription)) {
      score += 6;
    }
    if (title.includes(normalizedDescription)) {
      score += 6;
    }

    // Enhanced SelectBox component scoring
    if (isSelectBoxComponent) {
      score += 3; // Bonus for being a SelectBox component
      if (selectBoxButtonText.trim() === description) {
        score += 15;
      }
      if (selectBoxButtonText.includes(description)) {
        score += 10;
      }
    }

    // Enhanced FormRenderer field scoring
    if (isFormRendererField) {
      score += 2; // Bonus for being a FormRenderer field
      if (formFieldName.trim() === description) {
        score += 12;
      }
      if (formFieldName.includes(description)) {
        score += 8;
      }
    }

    // Medium priority matches (descriptive attributes)
    if (dataLabel.includes(description)) {
      score += 5;
    }
    if (dataTitle.includes(description)) {
      score += 5;
    }
    if (dataName.includes(description)) {
      score += 5;
    }
    if (dataTestId.includes(description)) {
      score += 5;
    }
    if (dataDesignSystem.includes(description) && dataDesignSystem !== 'true') {
      score += 5;
    } // Avoid generic 'true' values

    // New: data-numberinput and data-field support
    if (dataNumberinput.includes(description)) {
      score += 5;
    }
    if (dataField.includes(description)) {
      score += 5;
    }

    // Lower priority matches (structural identifiers)
    if (id.includes(description)) {
      score += 3;
    }
    if (dataButtonFor.includes(description)) {
      score += 3;
    }
    if (className.includes(description)) {
      score += 2;
    }

    // ReScript-specific class name matching
    if (className.includes('selectbox') || className.includes('select-box')) {
      score += 2;
    }
    if (className.includes('dropdown') || className.includes('combobox')) {
      score += 2;
    }
    if (className.includes('field-renderer') || className.includes('form-field')) {
      score += 1;
    }

    // Bonus for clickable elements (prefer directly clickable elements)
    const tagName = element.tagName.toLowerCase();
    if (tagName === 'a' && element.getAttribute('href')) {
      score += 7;
    } // Increased from 5 to 7
    if (tagName === 'button') {
      score += 5;
    }
    if (element.getAttribute('onclick')) {
      score += 3;
    }
    if (element.getAttribute('role') === 'button') {
      score += 3;
    }

    // NESTED STRUCTURE BONUS: Give extra points to clickable parents that contain target text
    if (
      hasNestedTextMatch &&
      ((tagName === 'a' && element.getAttribute('href')) || tagName === 'button')
    ) {
      score += 5; // Extra bonus for clickable parents of nested text
    }

    // Penalize hidden or disabled elements
    if (element.getAttribute('aria-hidden') === 'true') {
      score -= 10;
    }
    if (element.style.display === 'none') {
      score -= 10;
    }
    if (element.style.visibility === 'hidden') {
      score -= 10;
    }
    if ((element as HTMLButtonElement).disabled) {
      score -= 8;
    }

    // PENALIZE NON-CLICKABLE ELEMENTS that contain text but aren't actionable
    // This prevents text-containing divs from scoring higher than their clickable parents
    if (textContent.includes(description) && !this._isElementClickable(element)) {
      score -= 3; // Reduce score for non-clickable elements
    }

    return score;
  }

  private _isElementClickable(element: HTMLElement): boolean {
    // Check if element has zero dimensions
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }

    // Check computed styles
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    if (style.pointerEvents === 'none') {
      return false;
    }

    // Check if element is actually visible in viewport (basic check)
    if (rect.top < 0 && rect.bottom < 0) {
      return false;
    }
    if (rect.left < 0 && rect.right < 0) {
      return false;
    }

    // Check for semantic clickability
    const tagName = element.tagName.toLowerCase();
    const hasHref = element.getAttribute('href') !== null;
    const hasOnClick = element.getAttribute('onclick') !== null;
    const hasButtonRole = element.getAttribute('role') === 'button';
    const isInputButton =
      tagName === 'input' &&
      ['button', 'submit'].includes((element as HTMLInputElement).type || '');

    // Element is semantically clickable
    if (
      tagName === 'button' ||
      (tagName === 'a' && hasHref) ||
      isInputButton ||
      hasOnClick ||
      hasButtonRole
    ) {
      return true;
    }

    // Check if element has cursor pointer (indicating clickability)
    if (style.cursor === 'pointer') {
      return true;
    }

    // For div and other generic elements, be more permissive if they have clickable styling
    if (hasOnClick || hasButtonRole) {
      return true;
    }

    // Default to false for generic elements without clear clickable indicators
    return tagName === 'button' || (tagName === 'a' && hasHref);
  }

  private _isElementFillable(element: HTMLElement): boolean {
    const tagName = element.tagName.toLowerCase();
    const type = (element as HTMLInputElement).type?.toLowerCase();

    // Standard HTML elements
    if (tagName === 'input') {
      const fillableTypes = ['text', 'email', 'password', 'tel', 'url', 'search', 'number'];
      return fillableTypes.includes(type ?? 'text');
    }

    if (tagName === 'textarea') {
      return true;
    }
    if (tagName === 'select') {
      return true;
    }
    if (element.contentEditable === 'true') {
      return true;
    }

    // ReScript SelectBox components (custom dropdowns)
    if (this._detectSelectBoxComponent(element)) {
      return true;
    }

    // Check if element is within a SelectBox component
    if (element.closest('[data-selectbox-value]')) {
      return true;
    }

    // Check if element is a button within a form field wrapper (could be a custom select)
    if (tagName === 'button' && element.closest('[data-component-field-wrapper]')) {
      const fieldWrapper = element.closest('[data-component-field-wrapper]');
      // If the field wrapper contains selectbox indicators, this button is fillable
      if (fieldWrapper?.querySelector('[data-selectbox-value]')) {
        return true;
      }
    }

    return false;
  }

  private _clickElement(
    element: HTMLElement,
    button: ClickOptions['button'],
    clickCount: number
  ): void {
    this.forcelog(
      '[KRIYA DEBUG] _clickElement called for:',
      element.tagName,
      element.getAttribute('href')
    );

    // Method 1: Try synthetic events first
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      button: button === 'left' ? 0 : button === 'right' ? 2 : 1,
      detail: clickCount,
    };

    let clickHandled = false;

    for (let i = 0; i < clickCount; i++) {
      const mousedownEvent = new MouseEvent('mousedown', eventOptions);
      const mouseupEvent = new MouseEvent('mouseup', eventOptions);
      const clickEvent = new MouseEvent('click', eventOptions);

      this.forcelog('[KRIYA DEBUG] Dispatching mousedown event');
      const mousedownResult = element.dispatchEvent(mousedownEvent);
      this.forcelog('[KRIYA DEBUG] Mousedown event result:', mousedownResult);

      this.forcelog('[KRIYA DEBUG] Dispatching mouseup event');
      const mouseupResult = element.dispatchEvent(mouseupEvent);
      this.forcelog('[KRIYA DEBUG] Mouseup event result:', mouseupResult);

      this.forcelog('[KRIYA DEBUG] Dispatching click event');
      const clickResult = element.dispatchEvent(clickEvent);
      this.forcelog('[KRIYA DEBUG] Click event result:', clickResult);

      if (clickResult) {
        clickHandled = true;
      }
    }

    // Method 2: For links with _blank target, try opening in new window
    // Skip forced navigation for same-window links to allow SPA routing
    let openedViaBlank = false;
    if (element.tagName.toLowerCase() === 'a') {
      const href = element.getAttribute('href');
      const target = element.getAttribute('target');

      if (href && target === '_blank') {
        this.forcelog('[KRIYA DEBUG] _blank target detected, attempting window.open');
        try {
          const newWindow = window.open(href, '_blank');
          if (newWindow && !newWindow.closed) {
            this.forcelog('[KRIYA DEBUG] window.open succeeded');
            element.focus();
            openedViaBlank = true;
          }
        } catch (error) {
          this.forcelog('[KRIYA DEBUG] window.open failed:', error);
        }
      }
    }

    // Method 3: Try native click if immediate redirect didn't work
    if (!clickHandled && element.tagName.toLowerCase() !== 'a') {
      this.forcelog('[KRIYA DEBUG] Trying native click() method');
      try {
        (element as HTMLElement).click();
        this.forcelog('[KRIYA DEBUG] Native click() executed');
      } catch (error) {
        this.forcelog('[KRIYA DEBUG] Native click() failed:', error);
      }
    } else if (element.tagName.toLowerCase() === 'a') {
      this.forcelog('[KRIYA DEBUG] Skipping native click() on link to avoid SPA navigation issues');
    }

    // Method 4: For links, try enhanced navigation techniques
    if (element.tagName.toLowerCase() === 'a') {
      const href = element.getAttribute('href');
      const target = element.getAttribute('target');

      if (href && (href.startsWith('http') || href.startsWith('/') || href.startsWith('./'))) {
        // For relative URLs, use the full URL we constructed earlier
        let targetUrl = href;
        if (href.startsWith('/') || href.startsWith('./')) {
          targetUrl = new URL(href, window.location.origin).href;
          this.forcelog(`[KRIYA DEBUG] Using full URL for enhanced techniques: ${targetUrl}`);
        }
        this.forcelog(`[KRIYA DEBUG] Attempting enhanced navigation techniques for: ${targetUrl}`);

        // Method 3a: Try creating a temporary hidden link and clicking it
        // Only do this for _blank targets to avoid SPA navigation issues
        // Skip if window.open already succeeded
        if (target === '_blank' && !openedViaBlank) {
          this.forcelog('[KRIYA DEBUG] Method 3a: Creating temporary link for _blank target');
          try {
            const tempLink = document.createElement('a');
            tempLink.href = targetUrl;
            tempLink.target = '_blank';
            tempLink.style.display = 'none';
            tempLink.style.position = 'absolute';
            tempLink.style.left = '-9999px';
            document.body.appendChild(tempLink);

            // Try clicking the temporary link
            tempLink.click();
            this.forcelog('[KRIYA DEBUG] Temporary link clicked');

            // Clean up
            setTimeout(() => {
              document.body.removeChild(tempLink);
              this.forcelog('[KRIYA DEBUG] Temporary link cleaned up');
            }, 100);
          } catch (error) {
            this.forcelog('[KRIYA DEBUG] Temporary link method failed:', error);
          }
        } else if (target === '_blank' && openedViaBlank) {
          this.forcelog('[KRIYA DEBUG] Skipping temporary link - window.open already succeeded');
        } else {
          this.forcelog('[KRIYA DEBUG] Skipping temporary link - not a _blank target (SPA safe)');
        }

        // Method 3b: Try focus + Enter key simulation
        this.forcelog('[KRIYA DEBUG] Method 3b: Focus + Enter key simulation');
        try {
          element.focus();

          // Dispatch Enter key press
          const enterKeyEvent = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          });

          const enterResult = element.dispatchEvent(enterKeyEvent);
          this.forcelog('[KRIYA DEBUG] Enter key event result:', enterResult);
        } catch (error) {
          this.forcelog('[KRIYA DEBUG] Enter key simulation failed:', error);
        }

        // Method 3c: Enhanced direct navigation with user gesture simulation
        setTimeout(() => {
          const currentLocation = window.location.href;
          this.forcelog(
            `[KRIYA DEBUG] Current location after enhanced methods: ${currentLocation}`
          );

          // Only use enhanced navigation for _blank targets
          // For same-window links, we rely on synthetic events and SPA detection in Method 2
          // Skip if window.open already succeeded
          if (target === '_blank' && !openedViaBlank) {
            this.forcelog('[KRIYA DEBUG] _blank target - using enhanced navigation');
            try {
              this._openInNewWindowWithFallbacks(targetUrl, currentLocation);
            } catch (error) {
              this.forcelog('[KRIYA DEBUG] Enhanced direct navigation failed:', error);
              this._showNavigationAssistance(href);
            }
          } else if (target === '_blank' && openedViaBlank) {
            this.forcelog(
              '[KRIYA DEBUG] _blank target - skipping enhanced navigation, window.open already succeeded'
            );
          } else {
            this.forcelog(
              '[KRIYA DEBUG] Same-window link - NOT forcing navigation. Relying on synthetic events.'
            );
          }
        }, 300); // Increased delay to allow for navigation
      }
    }

    element.focus();
    this.forcelog('[KRIYA DEBUG] Element focused');
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
    // Handle ReScript SelectBox components (custom dropdowns)
    if (this._detectSelectBoxComponent(element) || element.closest('[data-selectbox-value]')) {
      this._fillReScriptSelectBox(element, value);
      return;
    }

    // Handle standard HTML select elements
    if (element.tagName.toLowerCase() === 'select') {
      const selectElement = element as HTMLSelectElement;
      const option = Array.from(selectElement.options).find(
        opt => opt.value === value || opt.textContent === value
      );

      if (option) {
        selectElement.selectedIndex = option.index;
      } else {
        throw new AutomationError(`Option not found in select: ${value}`, 'ELEMENT_NOT_FOUND');
      }
    } else {
      // Handle standard input/textarea elements
      // Use native setter to bypass React's controlled component tracking,
      // so React reconciles its internal state with the new value.
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        element.tagName.toLowerCase() === 'textarea'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype,
        'value'
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(element, value);
      } else {
        (element as HTMLInputElement | HTMLTextAreaElement).value = value;
      }
    }

    if (triggerEvents) {
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  private _fillReScriptSelectBox(element: HTMLElement, value: string): void {
    // Find the SelectBox container and button
    const selectBoxContainer =
      element.closest('[data-selectbox-value]') ||
      (element.hasAttribute('data-selectbox-value') ? element : null);

    if (!selectBoxContainer) {
      throw new AutomationError('SelectBox container not found', 'ELEMENT_NOT_FOUND');
    }

    // Find the trigger button for the dropdown
    const triggerButton = selectBoxContainer.querySelector(
      'button[data-value]'
    ) as HTMLButtonElement;

    if (!triggerButton) {
      throw new AutomationError('SelectBox trigger button not found', 'ELEMENT_NOT_FOUND');
    }

    // Click the button to open the dropdown
    this._clickElement(triggerButton, 'left', 1);

    // Wait a moment for the dropdown to open
    setTimeout(() => {
      // Look for the dropdown options
      const dropdown =
        document.querySelector('[data-dropdown="dropdown"]') ||
        selectBoxContainer.querySelector('[role="listbox"]') ||
        document.querySelector('[class*="dropdown"][class*="open"]') ||
        document.querySelector('[class*="options"]');

      if (!dropdown) {
        throw new AutomationError(
          'SelectBox dropdown not found after opening',
          'ELEMENT_NOT_FOUND'
        );
      }

      // Find the option to select (try multiple strategies)
      let optionToSelect: HTMLElement | null = null;

      // Strategy 1: Look for exact data-dropdown-value match
      optionToSelect = dropdown.querySelector(`[data-dropdown-value="${value}"]`) as HTMLElement;

      // Strategy 2: Look for exact text content match
      if (!optionToSelect) {
        const options = dropdown.querySelectorAll(
          '[data-dropdown-value], [role="option"], li, div[class*="option"]'
        );
        optionToSelect = Array.from(options).find(option => {
          const text = option.textContent?.trim().toLowerCase();
          const dataValue = option.getAttribute('data-dropdown-value')?.toLowerCase();
          const targetValue = value.toLowerCase();

          return text === targetValue || dataValue === targetValue;
        }) as HTMLElement;
      }

      // Strategy 3: Look for partial text match
      if (!optionToSelect) {
        const options = dropdown.querySelectorAll(
          '[data-dropdown-value], [role="option"], li, div[class*="option"]'
        );
        optionToSelect = Array.from(options).find(option => {
          const text = option.textContent?.trim().toLowerCase();
          const dataValue = option.getAttribute('data-dropdown-value')?.toLowerCase();
          const targetValue = value.toLowerCase();

          return text?.includes(targetValue) || dataValue?.includes(targetValue);
        }) as HTMLElement;
      }

      if (!optionToSelect) {
        throw new AutomationError(
          `Option "${value}" not found in SelectBox dropdown`,
          'ELEMENT_NOT_FOUND'
        );
      }

      // Click the selected option
      this._clickElement(optionToSelect, 'left', 1);

      // Update the button's data-value attribute to reflect the selection
      const selectedValue =
        optionToSelect.getAttribute('data-dropdown-value') ||
        optionToSelect.textContent?.trim() ||
        value;

      triggerButton.setAttribute('data-value', selectedValue);

      // Update button text if it has data-button-text element
      const buttonTextElement = triggerButton.querySelector('[data-button-text]');
      if (buttonTextElement) {
        buttonTextElement.textContent = optionToSelect.textContent?.trim() || value;
        buttonTextElement.setAttribute(
          'data-button-text',
          optionToSelect.textContent?.trim() || value
        );
      }

      // Trigger change events on the SelectBox container for React/form libraries
      selectBoxContainer.dispatchEvent(new Event('change', { bubbles: true }));
      selectBoxContainer.dispatchEvent(
        new CustomEvent('select', {
          detail: { value: selectedValue },
          bubbles: true,
        })
      );
    }, 100); // Small delay to ensure dropdown is rendered
  }

  private async _waitForCondition(
    selector: string,
    condition: WaitOptions['condition'],
    timeout?: number
  ): Promise<void> {
    const maxWait = timeout ?? this._config.timeout;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      let element: HTMLElement | null = null;

      // First try as CSS selector
      element = document.querySelector(selector) as HTMLElement;

      // If not found by CSS selector, try text-based search (like _findElement does)
      if (!element) {
        element = await this._findElementByText(selector);
      }

      if (this._checkCondition(element, condition)) {
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new AutomationError(`Wait condition not met within ${maxWait}ms`, 'EXECUTION_TIMEOUT', {
      selector,
      condition,
    });
  }

  private async _findElementByText(
    text: string,
    preferInput: boolean = false
  ): Promise<HTMLElement | null> {
    this.forcelog(
      `[KRIYA DEBUG] _findElementByText searching for: "${text}", preferInput: ${preferInput}`
    );

    // Create case-insensitive text matcher
    const searchText = text.toLowerCase().trim();

    // For fill operations, prioritize finding the actual input, not the label
    if (preferInput) {
      // First, find all input/textarea/select elements
      const inputs = document.querySelectorAll('input, textarea, select');
      for (const input of inputs) {
        const el = input as HTMLElement;
        // Check if input has matching attributes
        if (
          el.getAttribute('placeholder')?.toLowerCase().includes(searchText) ||
          el.getAttribute('aria-label')?.toLowerCase().includes(searchText) ||
          el.getAttribute('data-testid')?.toLowerCase().includes(searchText) ||
          el.getAttribute('data-label')?.toLowerCase().includes(searchText) ||
          el.getAttribute('data-numberinput')?.toLowerCase().includes(searchText) ||
          el.getAttribute('data-field')?.toLowerCase().includes(searchText) ||
          el.id?.toLowerCase().includes(searchText) ||
          (el as HTMLInputElement).name?.toLowerCase().includes(searchText)
        ) {
          this.forcelog('[KRIYA DEBUG] _findElementByText found INPUT by attribute:', el);
          return el;
        }
      }

      // Try to find label with matching text, then get associated input
      const labels = document.querySelectorAll('label');
      for (const label of labels) {
        const labelText = (label.textContent || '').toLowerCase().trim();
        if (labelText.includes(searchText)) {
          // Try to find associated input
          const forAttr = label.getAttribute('for');
          if (forAttr) {
            const inputById = document.getElementById(forAttr) as HTMLInputElement;
            if (inputById && this._isElementFillable(inputById)) {
              this.forcelog(
                '[KRIYA DEBUG] _findElementByText found input via label for:',
                inputById
              );
              return inputById;
            }
          }
          // Try to find input inside label
          const inputInside = label.querySelector('input, textarea, select') as HTMLInputElement;
          if (inputInside && this._isElementFillable(inputInside)) {
            this.forcelog(
              '[KRIYA DEBUG] _findElementByText found input inside label:',
              inputInside
            );
            return inputInside;
          }
        }
      }

      // Look for input in same container as matching label
      const allLabels = document.querySelectorAll('label, span, div');
      for (const el of allLabels) {
        const elText = (el.textContent || '').toLowerCase().trim();
        if (elText.includes(searchText)) {
          // Look for sibling or parent input
          let parent = el.parentElement;
          for (let i = 0; i < 3; i++) {
            if (!parent) {
              break;
            }
            const nearbyInput = parent.querySelector('input, textarea, select') as HTMLInputElement;
            if (nearbyInput && this._isElementFillable(nearbyInput)) {
              this.forcelog(
                '[KRIYA DEBUG] _findElementByText found input near label:',
                nearbyInput
              );
              return nearbyInput;
            }
            parent = parent.parentElement;
          }
        }
      }
    }

    // Search strategies in order of priority (for non-fill or when fill fails)
    const selectors = [
      // Data attributes
      `[data-label*="${searchText}" i]`,
      `[data-placeholder*="${searchText}" i]`,
      `[aria-label*="${searchText}" i]`,
      `[data-testid*="${searchText}" i]`,
      `[data-id*="${searchText}" i]`,
      `[data-element*="${searchText}" i]`,
      // Button/text content
      `button:contains("${text}")`,
      `[role="button"]:contains("${text}")`,
    ];

    // Try exact match first
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel) as HTMLElement;
        if (el && this._isElementClickable(el)) {
          this.forcelog(`[KRIYA DEBUG] _findElementByText found via ${sel}:`, el);
          return el;
        }
      } catch {
        // Skip invalid selectors
      }
    }

    // Fallback: walk the DOM looking for matching text - but prioritize INPUT first
    // First pass: find matching INPUT elements
    const inputElements = document.querySelectorAll('input, textarea, select');
    for (const input of inputElements) {
      const el = input as HTMLElement;
      if (
        el.getAttribute('placeholder')?.toLowerCase().includes(searchText) ||
        el.getAttribute('aria-label')?.toLowerCase().includes(searchText) ||
        el.getAttribute('data-testid')?.toLowerCase().includes(searchText) ||
        el.getAttribute('data-label')?.toLowerCase().includes(searchText)
      ) {
        this.forcelog('[KRIYA DEBUG] _findElementByText found INPUT in DOM walk:', el);
        return el;
      }
    }

    // Second pass: find non-link elements with matching text
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);

    let node: Node | null = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const elText = (el.textContent || el.innerText || '').toLowerCase().trim();
        const tagName = el.tagName.toLowerCase();

        // Skip non-clickable elements
        if (tagName === 'a' || tagName === 'script' || tagName === 'style') {
          node = walker.nextNode();
          continue;
        }

        // Check for matches in various attributes
        if (
          elText === searchText ||
          el.getAttribute('data-label')?.toLowerCase().includes(searchText) ||
          el.getAttribute('data-placeholder')?.toLowerCase().includes(searchText) ||
          el.getAttribute('aria-label')?.toLowerCase().includes(searchText) ||
          el.getAttribute('data-testid')?.toLowerCase().includes(searchText) ||
          el.getAttribute('data-id')?.toLowerCase().includes(searchText) ||
          el.getAttribute('data-element')?.toLowerCase().includes(searchText) ||
          el.getAttribute('data-button')?.toLowerCase().includes(searchText)
        ) {
          this.forcelog('[KRIYA DEBUG] _findElementByText found via DOM walk:', el);
          return el;
        }
      }
      node = walker.nextNode();
    }

    this.forcelog(`[KRIYA DEBUG] _findElementByText - no element found for: "${text}"`);
    return null;
  }

  private _checkCondition(
    element: HTMLElement | null,
    condition: WaitOptions['condition']
  ): boolean {
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
    if (element.hasAttribute('data-selectbox-value')) {
      return true;
    }
    if (element.closest('[data-selectbox-value]')) {
      return true;
    }

    // Check for button elements with Euler SelectBox patterns
    if (tagName === 'button') {
      if (element.hasAttribute('data-value') && element.querySelector('[data-button-text]')) {
        return true;
      }
      if (element.hasAttribute('data-value') && element.closest('[data-selectbox-value]')) {
        return true;
      }
    }

    // Check for common SelectBox patterns in ReScript components
    if (className.includes('selectbox') || className.includes('select-box')) {
      return true;
    }
    if (className.includes('dropdown') || className.includes('combobox')) {
      return true;
    }

    // Check for button elements that might be SelectBox triggers
    if (tagName === 'button') {
      // Look for dropdown-related classes or attributes
      if (element.getAttribute('aria-haspopup') === 'listbox') {
        return true;
      }
      if (element.getAttribute('role') === 'combobox') {
        return true;
      }
      if (className.includes('dropdown') || className.includes('select')) {
        return true;
      }
    }

    // Check if parent container has SelectBox patterns
    const parent = element.parentElement;
    if (parent) {
      const parentClass = String(parent.className || '').toLowerCase();
      if (parentClass.includes('selectbox') || parentClass.includes('select-box')) {
        return true;
      }
      if (parentClass.includes('dropdown') || parentClass.includes('combobox')) {
        return true;
      }
    }

    // Check for ReScript compiled class patterns (typically have BS prefix)
    if (
      className.includes('bs-') &&
      (className.includes('select') || className.includes('dropdown'))
    ) {
      return true;
    }

    return false;
  }

  private _detectFormRendererField(element: HTMLElement): boolean {
    const className = String(element.className || '').toLowerCase();

    // PRIMARY: Check for Euler dashboard form field data attributes (highest priority)
    if (element.hasAttribute('data-component-field-wrapper')) {
      return true;
    }
    if (element.closest('[data-component-field-wrapper]')) {
      return true;
    }
    if (element.hasAttribute('data-form-label')) {
      return true;
    }
    if (element.hasAttribute('data-design-system')) {
      return true;
    }

    // Check for FormRenderer field patterns
    if (className.includes('field-renderer') || className.includes('form-field')) {
      return true;
    }
    if (className.includes('field-container') || className.includes('form-container')) {
      return true;
    }

    // Check parent elements for FormRenderer patterns
    let current = element.parentElement;
    let depth = 0;
    while (current && depth < 5) {
      // Check up to 5 levels up
      const parentClass = String(current.className || '').toLowerCase();
      if (parentClass.includes('field-renderer') || parentClass.includes('form-field')) {
        return true;
      }
      if (parentClass.includes('field-container') || parentClass.includes('form-container')) {
        return true;
      }

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
    if (text) {
      return text.toLowerCase();
    }

    // Look for data-button-text in children
    const buttonTextElement = element.querySelector('[data-button-text]');
    if (buttonTextElement) {
      text =
        buttonTextElement.getAttribute('data-button-text') ||
        buttonTextElement.textContent?.trim() ||
        '';
      if (text) {
        return text.toLowerCase();
      }
    }

    // Check for selectbox value attribute
    text = element.getAttribute('data-selectbox-value') || '';
    if (text) {
      return text.toLowerCase();
    }

    // Look for selectbox value in parents
    const selectboxContainer = element.closest('[data-selectbox-value]');
    if (selectboxContainer) {
      text = selectboxContainer.getAttribute('data-selectbox-value') || '';
      if (text) {
        return text.toLowerCase();
      }
    }

    // Direct text content
    text = element.textContent?.trim() || '';
    if (text) {
      return text.toLowerCase();
    }

    // Check for button elements within or as the element
    if (element.tagName.toLowerCase() === 'button') {
      text = element.textContent?.trim() || '';
      if (text) {
        return text.toLowerCase();
      }
    }

    // Look for button children
    const button = element.querySelector('button');
    if (button) {
      text = button.textContent?.trim() || '';
      if (text) {
        return text.toLowerCase();
      }
    }

    // Check standard data attributes as fallback
    text = element.getAttribute('aria-label') || element.getAttribute('title') || '';

    return text.toLowerCase();
  }

  private _extractFormFieldName(element: HTMLElement): string {
    // Extract field name from Euler dashboard FormRenderer fields
    let name = '';

    // PRIMARY: Check for Euler-specific data attributes
    name = element.getAttribute('data-component-field-wrapper') || '';
    if (name) {
      return name.toLowerCase();
    }

    // Look for field wrapper in parents
    const fieldWrapper = element.closest('[data-component-field-wrapper]');
    if (fieldWrapper) {
      name = fieldWrapper.getAttribute('data-component-field-wrapper') || '';
      if (name) {
        return name.toLowerCase();
      }
    }

    // Check for form label data attribute
    name = element.getAttribute('data-form-label') || '';
    if (name) {
      return name.toLowerCase();
    }

    // Look for form label in the field
    const labelElement =
      element.querySelector('[data-form-label]') ||
      element.closest('[data-component-field-wrapper]')?.querySelector('[data-form-label]');
    if (labelElement) {
      name = labelElement.getAttribute('data-form-label') || labelElement.textContent?.trim() || '';
      if (name) {
        return name.toLowerCase();
      }
    }

    // Standard name attribute
    name = element.getAttribute('name') || '';
    if (name) {
      return name.toLowerCase();
    }

    // Check data-name attribute
    name = element.getAttribute('data-name') || '';
    if (name) {
      return name.toLowerCase();
    }

    // Look for input elements within the field
    const input = element.querySelector('input, select, textarea');
    if (input) {
      name = input.getAttribute('name') || '';
      if (name) {
        return name.toLowerCase();
      }
    }

    // Check parent elements for name attributes
    let current = element.parentElement;
    let depth = 0;
    while (current && depth < 3) {
      // Check up to 3 levels up
      name = current.getAttribute('name') || current.getAttribute('data-name') || '';
      if (name) {
        return name.toLowerCase();
      }

      current = current.parentElement;
      depth++;
    }

    // Look for label text as fallback
    const label = element.querySelector('label');
    if (label) {
      name = label.textContent?.trim() || '';
      if (name) {
        return name.toLowerCase();
      }
    }

    return '';
  }

  /**
   * Try a waterfall of `window.open` variants (no-features, minimal, popup),
   * then a `parent.open` attempt and finally a hidden-form submission, before
   * falling back to showing the user a manual-open assistance panel. Extracted
   * from `click()` to keep nesting depth manageable.
   */
  private _openInNewWindowWithFallbacks(targetUrl: string, currentLocation: string): void {
    this.forcelog('[KRIYA DEBUG] Method 3c1: window.open with user gesture simulation');

    const userGestureEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
    });
    document.dispatchEvent(userGestureEvent);

    // Method 3c1a..c: window.open variants.
    const variants: Array<string | undefined> = [
      undefined,
      'toolbar=yes,scrollbars=yes,resizable=yes',
      'width=800,height=600,scrollbars=yes,resizable=yes',
    ];
    for (const features of variants) {
      const opened = features
        ? window.open(targetUrl, '_blank', features)
        : window.open(targetUrl, '_blank');
      if (opened) {
        this.forcelog(
          `[KRIYA DEBUG] window.open succeeded${features ? ` (features="${features}")` : ''}`
        );
        return;
      }
    }
    this.forcelog('[KRIYA DEBUG] All window.open methods blocked (likely popup blocker)');

    // Method 3c2: parent.open assignment.
    try {
      if (window.parent && window.parent !== window) {
        window.parent.open(targetUrl, '_blank');
        this.forcelog('[KRIYA DEBUG] parent.open() executed');
        return;
      }
    } catch (parentError) {
      this.forcelog('[KRIYA DEBUG] parent.open() failed:', parentError);
    }

    // Method 3c3: hidden form submission.
    try {
      this.forcelog('[KRIYA DEBUG] Method 3c3: Creating form submission');
      const form = document.createElement('form');
      form.action = targetUrl;
      form.target = '_blank';
      form.method = 'GET';
      form.style.display = 'none';
      document.body.appendChild(form);
      form.submit();

      setTimeout(() => {
        document.body.removeChild(form);
      }, 100);

      setTimeout(() => {
        if (window.location.href === currentLocation) {
          this.forcelog('[KRIYA DEBUG] Form submission also failed - trying final fallback');
          this._showNavigationAssistance(targetUrl);
        } else {
          this.forcelog('[KRIYA DEBUG] Form submission appears to have worked');
        }
      }, 500);
    } catch (formError) {
      this.forcelog('[KRIYA DEBUG] Form submission failed:', formError);
      this._showNavigationAssistance(targetUrl);
    }
  }

  /**
   * Show navigation assistance when automated clicking fails
   */
  private _showNavigationAssistance(href: string): void {
    this.forcelog(`[KRIYA DEBUG] Showing navigation assistance for: ${href}`);

    try {
      // Create a prominent notification overlay
      const notification = document.createElement('div');
      notification.id = 'kriya-navigation-assist';
      notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 999999;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        padding: 20px;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        line-height: 1.5;
        max-width: 350px;
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255,255,255,0.2);
        animation: kriyaSlideIn 0.3s ease-out;
      `;

      // Add CSS animation
      if (!document.getElementById('kriya-styles')) {
        const style = document.createElement('style');
        style.id = 'kriya-styles';
        style.textContent = `
          @keyframes kriyaSlideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
          }
          @keyframes kriyaSlideOut {
            from { transform: translateX(0); opacity: 1; }
            to { transform: translateX(100%); opacity: 0; }
          }
        `;
        document.head.appendChild(style);
      }

      notification.innerHTML = `
        <div style="display: flex; align-items: center; margin-bottom: 12px;">
          <div style="
            width: 24px; 
            height: 24px; 
            background: rgba(255,255,255,0.2); 
            border-radius: 50%; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            margin-right: 12px;
          ">🔗</div>
          <strong style="font-size: 16px;">Kriya Navigation Assistant</strong>
        </div>
        <div style="margin-bottom: 15px; opacity: 0.9;">
          Automatic navigation was blocked by browser security. 
        </div>
        <div style="margin-bottom: 15px;">
          <strong>Target:</strong> <span data-kriya-target style="font-family: monospace; background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px;"></span>
        </div>
        <div style="display: flex; gap: 8px; margin-bottom: 10px;">
          <button id="kriya-open-link" style="
            background: rgba(255,255,255,0.2);
            border: 1px solid rgba(255,255,255,0.3);
            color: white;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            transition: all 0.2s;
          ">📋 Copy Link</button>
          <button id="kriya-dismiss" style="
            background: transparent;
            border: 1px solid rgba(255,255,255,0.3);
            color: white;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            transition: all 0.2s;
          ">✕ Dismiss</button>
        </div>
        <div style="font-size: 12px; opacity: 0.7;">
          The link has been copied to your clipboard for manual opening.
        </div>
      `;

      const targetSpan = notification.querySelector(
        '[data-kriya-target]'
      ) as HTMLSpanElement | null;
      if (targetSpan) {
        targetSpan.textContent = href;
      }

      // Add hover effects
      const buttons = notification.querySelectorAll('button');
      buttons.forEach(button => {
        button.addEventListener('mouseenter', () => {
          (button as HTMLElement).style.background = 'rgba(255,255,255,0.3)';
        });
        button.addEventListener('mouseleave', () => {
          if (button.id === 'kriya-open-link') {
            (button as HTMLElement).style.background = 'rgba(255,255,255,0.2)';
          } else {
            (button as HTMLElement).style.background = 'transparent';
          }
        });
      });

      // Copy link functionality
      const copyButton = notification.querySelector('#kriya-open-link') as HTMLButtonElement;
      copyButton.addEventListener('click', () => {
        this.forcelog('[KRIYA DEBUG] Copy link button clicked');
        try {
          // Try to copy to clipboard
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard
              .writeText(href)
              .then(() => {
                copyButton.innerHTML = '✅ Copied!';
                setTimeout(() => {
                  copyButton.innerHTML = '📋 Copy Link';
                }, 2000);
              })
              .catch(() => {
                this._fallbackCopyToClipboard(href, copyButton);
              });
          } else {
            this._fallbackCopyToClipboard(href, copyButton);
          }
        } catch (error) {
          this.forcelog('[KRIYA DEBUG] Copy failed:', error);
          copyButton.innerHTML = '❌ Copy Failed';
        }
      });

      // Dismiss functionality
      const dismissButton = notification.querySelector('#kriya-dismiss') as HTMLButtonElement;
      dismissButton.addEventListener('click', () => {
        this.forcelog('[KRIYA DEBUG] Dismiss button clicked');
        this._dismissNotification(notification);
      });

      // Auto-dismiss after 10 seconds
      setTimeout(() => {
        if (document.body.contains(notification)) {
          this._dismissNotification(notification);
        }
      }, 10000);

      // Remove any existing notifications
      const existing = document.getElementById('kriya-navigation-assist');
      if (existing) {
        existing.remove();
      }

      // Add to page
      document.body.appendChild(notification);

      // Automatically copy the link
      setTimeout(() => {
        copyButton.click();
      }, 500);

      this.forcelog('[KRIYA DEBUG] Navigation assistance displayed');
    } catch (error) {
      this.forcelog('[KRIYA DEBUG] Failed to show navigation assistance:', error);

      // Fallback: Just log and show alert. Gated on debugMode so library code
      // doesn't write to consumers' consoles unsolicited.
      if (this._config.debugMode) {
        console.warn(`Kriya: Unable to navigate to ${href}. Please open this link manually.`);
      }

      // Try basic alert as last resort
      try {
        alert(`Kriya Navigation: Please manually open this link: ${href}`);
      } catch (alertError) {
        this.forcelog('[KRIYA DEBUG] Alert also failed:', alertError);
      }
    }
  }

  private _fallbackCopyToClipboard(text: string, button: HTMLButtonElement): void {
    try {
      // Create a temporary textarea element
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();

      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);

      if (successful) {
        button.innerHTML = '✅ Copied!';
        this.forcelog('[KRIYA DEBUG] Fallback copy successful');
      } else {
        button.innerHTML = '❌ Copy Failed';
        this.forcelog('[KRIYA DEBUG] Fallback copy failed');
      }

      setTimeout(() => {
        button.innerHTML = '📋 Copy Link';
      }, 2000);
    } catch (error) {
      this.forcelog('[KRIYA DEBUG] Fallback copy failed:', error);
      button.innerHTML = '❌ Copy Failed';
    }
  }

  private _dismissNotification(notification: HTMLElement): void {
    notification.style.animation = 'kriyaSlideOut 0.3s ease-in forwards';
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 300);
  }
}
