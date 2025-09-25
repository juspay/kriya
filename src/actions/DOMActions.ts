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

    const target = options.description || options.selector || '';
    console.log(`🖱️ Kriya click (enhanced implementation): ${target}`);

    // Enhanced DOM approach
    console.log(`🖱️ Kriya enhanced DOM click: ${target}`);

    // Coordinate-first when no selector/description is provided
    if (!target && options.position) {
      try {
        const vx = options.position.x;
        const vy = options.position.y;

        // Treat given coords as viewport by default; if they look like page coords, adjust
        const isLikelyPageCoords = vx > window.innerWidth + 5 || vy > window.innerHeight + 5;
        const clientX = isLikelyPageCoords ? vx - window.scrollX : vx;
        const clientY = isLikelyPageCoords ? vy - window.scrollY : vy;

        const elAtPoint = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
        if (elAtPoint) {
          console.log(`🎯 Found element at point (${clientX}, ${clientY}): ${elAtPoint.tagName}`);
          const rectAt = elAtPoint.getBoundingClientRect();
          const relX = Math.max(0, Math.min(clientX - rectAt.left, rectAt.width));
          const relY = Math.max(0, Math.min(clientY - rectAt.top, rectAt.height));

          // Scroll into view and focus to maximize success
          try {
            elAtPoint.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
          } catch {}
          try {
            elAtPoint.focus();
          } catch {}

          this._clickAtPosition(
            elAtPoint,
            { x: relX, y: relY },
            options.button,
            options.clickCount
          );
          console.log(`✅ Clicked at coordinates using elementFromPoint`);
          return;
        } else {
          console.log(`⚠️ No element found at point (${clientX}, ${clientY})`);
        }
      } catch (err) {
        console.log(`⚠️ Coordinate-based click path errored, will continue with search: ${err}`);
      }
    }

    // First, let's see how many elements we can find in total
    const allElements = document.querySelectorAll('*');
    console.log(`📊 Total DOM elements: ${allElements.length}`);

    const element = this._findElementByDescriptionEnhanced(target);
    if (!element) {
      console.error(`❌ Could not find clickable element: ${target}`);

      // Let's debug what we're searching for
      console.log(`🔍 Debug: Searching for "${target}"`);

      // Try to find any element with similar text
      const allClickableElements = document.querySelectorAll(
        'button, a, input, div, span, [onclick]'
      );
      console.log(`🔍 Found ${allClickableElements.length} potentially clickable elements`);

      // Log first 10 elements for debugging
      const debugCount = Math.min(allClickableElements.length, 10);
      for (let j = 0; j < debugCount; j++) {
        const el = allClickableElements[j] as HTMLElement;
        if (el) {
          const tagName = el.tagName || 'unknown';
          const textContent = el.textContent || '';
          const id = el.id || '';
          console.log(`📋 Element ${j}: ${tagName} text="${textContent}" id="${id}"`);
        }
      }

      throw new AutomationError(`Element not found: ${target}`, 'ELEMENT_NOT_FOUND', { target });
    }

    console.log(`🎯 Found element, preparing to click`);

    // Log element details for debugging
    const tagName = element.tagName || 'unknown';
    const textContent = element.textContent || '';
    const id = element.id || '';
    console.log(`📝 Element details: tag=${tagName}, text="${textContent}", id="${id}"`);

    // Ensure element is interactable
    const rect = element.getBoundingClientRect();
    const isVisible = rect.width > 0 && rect.height > 0;
    const isEnabled = !(element as HTMLInputElement).disabled;
    console.log(`👁️ Element visible: ${isVisible}, enabled: ${isEnabled}`);

    // Scroll into view to improve reliability
    try {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    } catch {}

    // Focus element first for better interaction
    try {
      element.focus();
      console.log(`🎯 Successfully focused element`);
    } catch (e) {
      console.log(`⚠️ Could not focus element`);
    }

    // Use Maya-style enhanced click implementation with multiple fallback methods
    try {
      if (options.position) {
        this._clickAtPosition(element, options.position, options.button, options.clickCount);
      } else {
        this._clickElementEnhanced(element, options.button, options.clickCount || 1);
      }
      console.log(
        `✅ Enhanced click dispatched: button=${options.button}, count=${options.clickCount}`
      );
    } catch (exn) {
      console.log(`❌ Enhanced click dispatch failed: ${exn}. Trying standard approach.`);
      try {
        this._clickElement(element, options.button, options.clickCount);
        console.log(`✅ Standard click events dispatched`);
      } catch (exn2) {
        console.log(`❌ Standard click failed: ${exn2}. Falling back to native click.`);
        try {
          (element as HTMLElement).click();
          console.log(`✅ Fallback native click executed`);
        } catch (exn3) {
          throw new AutomationError(
            `All click methods failed: ${exn3 instanceof Error ? exn3.message : 'Unknown error'}`,
            'EXECUTION_FAILED',
            { target, originalError: exn3 }
          );
        }
      }
    }

    console.log(`✅ Completed click for: ${target}`);
  }

  public async fill(options: FillOptions): Promise<void> {
    this._ensureInitialized();

    console.log(
      `📝 Kriya fill using enhanced approach: ${options.description || options.selector} with value: ${options.value}`
    );

    // Enhanced DOM approach
    const element = await this._findElementMayaStyle(options.selector, options.description);

    if (!this._isElementFillable(element)) {
      throw new AutomationError('Element is not fillable', 'ELEMENT_NOT_FOUND', {
        selector: options.selector,
        description: options.description,
      });
    }

    try {
      console.log(`📝 Kriya found fillable element using Maya approach, executing fill`);

      const inputElement = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

      // Maya's approach: focus first
      try {
        inputElement.focus();
        console.log(`🎯 Kriya focused input element`);
      } catch (e) {
        console.log(`⚠️ Could not focus input element`);
      }

      if (options.clearFirst) {
        this._clearElement(inputElement);
      }

      // Use enhanced fill approach
      this._fillElementEnhanced(inputElement, options.value, options.triggerEvents ?? true);

      console.log(`✅ Kriya Maya-style fill completed`);
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

    throw new AutomationError('Element not found', 'ELEMENT_NOT_FOUND', { selector, description });
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

    // Handle both regular HTML elements and SVG elements
    let className = '';
    try {
      if (typeof element.className === 'string') {
        className = element.className.toLowerCase();
      } else if (
        element.className &&
        typeof element.className === 'object' &&
        'baseVal' in element.className
      ) {
        // SVG elements have className as SVGAnimatedString
        className = (element.className as any).baseVal?.toLowerCase() ?? '';
      } else {
        // Fallback: get class attribute directly
        className = element.getAttribute('class')?.toLowerCase() ?? '';
      }
    } catch {
      // If all else fails, try to get class attribute
      className = element.getAttribute('class')?.toLowerCase() ?? '';
    }

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

    // Enhanced click implementation for React compatibility
    for (let i = 0; i < clickCount; i++) {
      // Focus the element first for better compatibility
      element.focus();

      // Dispatch comprehensive event sequence for React compatibility
      element.dispatchEvent(
        new PointerEvent('pointerdown', {
          ...eventOptions,
          pointerId: 1,
          pointerType: 'mouse',
        })
      );
      element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
      element.dispatchEvent(
        new PointerEvent('pointerup', {
          ...eventOptions,
          pointerId: 1,
          pointerType: 'mouse',
        })
      );
      element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
      element.dispatchEvent(new MouseEvent('click', eventOptions));

      // Try to trigger React's synthetic event system
      const syntheticEvent = new Event('click', { bubbles: true, cancelable: true });
      element.dispatchEvent(syntheticEvent);

      // For buttons and interactive elements, try calling click() method directly
      if (
        element.tagName.toLowerCase() === 'button' ||
        element.getAttribute('role') === 'button' ||
        (element as HTMLInputElement).type === 'button' ||
        (element as HTMLInputElement).type === 'submit'
      ) {
        try {
          (element as HTMLButtonElement).click();
        } catch (e) {
          // Ignore errors from direct click() calls
        }
      }
    }
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
      const option = Array.from(selectElement.options).find(
        opt => opt.value === value || opt.textContent === value
      );

      if (option) {
        selectElement.selectedIndex = option.index;
      } else {
        throw new AutomationError(`Option not found in select: ${value}`, 'ELEMENT_NOT_FOUND');
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

    throw new AutomationError(`Wait condition not met within ${maxWait}ms`, 'EXECUTION_TIMEOUT', {
      selector,
      condition,
    });
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

  // Maya-style element finding with sophisticated similarity scoring
  private async _findElementMayaStyle(
    selector?: string,
    description?: string
  ): Promise<HTMLElement> {
    console.log(`🔍 Starting enhanced Maya-style search for: "${description || selector}"`);

    // Try CSS selector first if it looks like one
    if (selector && (selector.includes('#') || selector.includes('.') || selector.includes('['))) {
      console.log(`🎯 Trying CSS selector approach`);
      try {
        const elements = document.querySelectorAll(selector) as NodeListOf<HTMLElement>;
        console.log(`🔍 CSS selector found ${elements.length} elements`);
        if (elements.length > 0 && elements[0]) {
          return elements[0];
        }
      } catch (e) {
        console.log(`❌ CSS selector failed: ${e}`);
      }
    }

    const searchTarget = description || selector || '';
    console.log(`🔍 Searching for target: "${searchTarget}"`);

    // If no search target, throw error immediately
    if (!searchTarget.trim()) {
      console.log(`❌ No search target provided`);
      throw new AutomationError(
        'No selector or description provided for element search',
        'VALIDATION_FAILED',
        { selector, description }
      );
    }

    // Step 1: Try exact text match first (most reliable)
    console.log(`🎯 Step 1: Trying exact text match`);
    const exactTextElements = Array.from(document.querySelectorAll('*')).filter(el => {
      const text = el.textContent?.trim() || '';
      return text === searchTarget;
    }) as HTMLElement[];

    if (exactTextElements.length > 0 && exactTextElements[0]) {
      console.log(`✅ Found exact text match: ${exactTextElements[0].tagName}`);
      return exactTextElements[0];
    }

    // Step 2: Try partial text match (contains)
    console.log(`🎯 Step 2: Trying partial text match`);
    const partialTextElements = Array.from(document.querySelectorAll('*')).filter(el => {
      const text = el.textContent?.toLowerCase().trim() || '';
      return text.includes(searchTarget.toLowerCase());
    }) as HTMLElement[];

    if (partialTextElements.length > 0 && partialTextElements[0]) {
      console.log(`✅ Found partial text match: ${partialTextElements[0].tagName}`);
      return partialTextElements[0];
    }

    // Step 3: Try attribute-based search
    console.log(`🎯 Step 3: Trying attribute-based search`);
    const attributeSelectors = [
      `[aria-label*="${searchTarget}" i]`,
      `[title*="${searchTarget}" i]`,
      `[placeholder*="${searchTarget}" i]`,
      `[data-testid*="${searchTarget}" i]`,
      `[data-test-id*="${searchTarget}" i]`,
      `[id*="${searchTarget}" i]`,
      `[class*="${searchTarget}" i]`,
    ];

    for (const attrSelector of attributeSelectors) {
      try {
        const elements = document.querySelectorAll(attrSelector) as NodeListOf<HTMLElement>;
        if (elements.length > 0 && elements[0]) {
          console.log(`✅ Found attribute match with ${attrSelector}: ${elements[0].tagName}`);
          return elements[0];
        }
      } catch (e) {
        // Ignore selector errors and continue
      }
    }

    // Step 4: Maya's original multi-tier element search with lowered threshold
    console.log(`🎯 Step 4: Trying Maya's comprehensive search`);

    // Get ALL potentially interactive elements
    const allInteractiveElements = Array.from(
      document.querySelectorAll(
        'button, [role=button], input, textarea, select, a, [onclick], [onkeydown], [tabindex], [role=tab], [role=menuitem], [data-testid], [data-test-id], [data-cy], .btn, .button, .clickable, .interactive, [class*="btn"], [class*="click"], [class*="action"], div, span, p, td, tr, li, h1, h2, h3, h4, h5, h6'
      )
    ) as HTMLElement[];

    console.log(`🔍 Found ${allInteractiveElements.length} total interactive elements`);

    // Use Maya's similarity scoring with multiple fallbacks
    let bestElement: HTMLElement | null = null;
    let bestScore = 0.0;
    const candidateElements: Array<{ element: HTMLElement; score: number; reason: string }> = [];

    for (let i = 0; i < allInteractiveElements.length; i++) {
      const element = allInteractiveElements[i];

      if (!element) continue;

      // Get element properties safely
      const textContent = element.textContent?.trim() || '';
      const placeholder = (element as HTMLInputElement).placeholder || '';
      const ariaLabel = element.getAttribute('aria-label') || '';
      const title = element.getAttribute('title') || '';
      const tagName = element.tagName.toLowerCase();
      const id = element.id || '';
      const className = element.className || '';

      // Calculate multiple types of similarity scores
      const textScore = this._calculateEnhancedSimilarity(searchTarget, textContent);
      const placeholderScore = this._calculateEnhancedSimilarity(searchTarget, placeholder);
      const ariaScore = this._calculateEnhancedSimilarity(searchTarget, ariaLabel);
      const titleScore = this._calculateEnhancedSimilarity(searchTarget, title);
      const idScore = this._calculateEnhancedSimilarity(searchTarget, id);
      const classScore = this._calculateEnhancedSimilarity(searchTarget, className);

      // Take the highest score from any attribute
      const maxScore = Math.max(
        textScore,
        placeholderScore,
        ariaScore,
        titleScore,
        idScore,
        classScore
      );

      // Apply adjustments but be more lenient
      const textLength = textContent.length;
      let sizeAdjustedScore = maxScore;

      // Less aggressive size penalties
      if (textLength > 1000) {
        sizeAdjustedScore = maxScore * 0.3; // Less harsh penalty
      } else if (textLength > 200) {
        sizeAdjustedScore = maxScore * 0.8; // Less harsh penalty
      }

      // Apply bonus for interactive elements
      let adjustedScore = sizeAdjustedScore;
      if (tagName === 'button' || tagName === 'input' || tagName === 'a') {
        adjustedScore = sizeAdjustedScore * 1.3; // Higher bonus for interactive elements
      } else if (element.hasAttribute('onclick') || element.hasAttribute('role')) {
        adjustedScore = sizeAdjustedScore * 1.2;
      }

      // Determine primary match reason and store candidate for debugging
      const reason =
        textScore > 0
          ? 'text'
          : placeholderScore > 0
            ? 'placeholder'
            : ariaScore > 0
              ? 'aria-label'
              : titleScore > 0
                ? 'title'
                : idScore > 0
                  ? 'id'
                  : 'class';

      if (adjustedScore > 0.0) {
        candidateElements.push({ element, score: adjustedScore, reason });
      }

      // Much lower threshold - accept any reasonable match
      if (adjustedScore > 0.1 && adjustedScore > bestScore) {
        bestElement = element;
        bestScore = adjustedScore;
        console.log(
          `🎯 Better match found: score ${adjustedScore.toFixed(3)} for ${tagName} (${reason})`
        );
      }
    }

    // Sort candidates by score for debugging
    candidateElements.sort((a, b) => b.score - a.score);

    // Log top candidates for debugging
    console.log(`🔍 Top 5 candidates:`);
    candidateElements.slice(0, 5).forEach((candidate, i) => {
      const { element, score, reason } = candidate;
      const text = element.textContent?.slice(0, 30) || '';
      console.log(
        `  ${i + 1}. ${element.tagName} (${reason}): score=${score.toFixed(3)}, text="${text}"`
      );
    });

    if (bestElement) {
      console.log(`✅ Best element found with score: ${bestScore.toFixed(3)}`);
      return bestElement;
    }

    // Step 5: Desperate fallback - try any element with matching text
    console.log(`🎯 Step 5: Desperate fallback - any element with matching text`);
    const desperateElements = Array.from(document.querySelectorAll('*')).filter(el => {
      const text = el.textContent?.toLowerCase() || '';
      return text.includes(searchTarget.toLowerCase()) && text.length < 200; // Avoid huge containers
    }) as HTMLElement[];

    if (desperateElements.length > 0) {
      const first = desperateElements[0]!;
      console.log(`✅ Found desperate fallback match: ${first.tagName}`);
      return first;
    }

    // Final attempt - log what elements are actually available
    console.log(`❌ No element found. Available elements:`);
    const allElements = Array.from(
      document.querySelectorAll('button, input, a, [role], [onclick]')
    ).slice(0, 10);
    allElements.forEach((el, i) => {
      const text = el.textContent?.slice(0, 30) || '';
      const tag = el.tagName;
      const id = (el as HTMLElement).id || '';
      const className = (el as HTMLElement).className || '';
      console.log(`  ${i + 1}. ${tag}#${id}.${className}: "${text}"`);
    });

    throw new AutomationError(
      `Element not found using enhanced Maya-style search. Searched for: "${searchTarget}". Found ${candidateElements.length} candidates but none met threshold.`,
      'ELEMENT_NOT_FOUND',
      {
        selector,
        description,
        searchTarget,
        candidatesFound: candidateElements.length,
        topCandidates: candidateElements.slice(0, 3).map(c => ({
          tag: c.element.tagName,
          score: c.score,
          reason: c.reason,
          text: c.element.textContent?.slice(0, 50),
        })),
      }
    );
  }

  // Enhanced similarity calculation algorithm with improved word matching
  private _calculateEnhancedSimilarity(text1: string, text2: string): number {
    // Extra safety checks for null/undefined inputs
    const safeText1 = text1 ? text1.toLowerCase().trim() : '';
    const safeText2 = text2 ? text2.toLowerCase().trim() : '';

    // If either string is empty, no match
    if (safeText1 === '' || safeText2 === '') {
      return 0.0;
    } else if (safeText1 === safeText2) {
      return 1.0;
    } else if (safeText1.includes(safeText2) || safeText2.includes(safeText1)) {
      // Higher score for substring matches
      return 0.9;
    } else {
      // Enhanced word-based similarity with better matching
      const words1 = safeText1.split(' ').filter(w => w !== '');
      const words2 = safeText2.split(' ').filter(w => w !== '');

      if (words1.length === 0 || words2.length === 0) {
        return 0.0;
      }

      let commonWords = 0;
      let partialMatches = 0;

      words1.forEach(word1 => {
        // Check for exact word matches
        if (words2.some(word2 => word1 === word2)) {
          commonWords++;
        } else {
          // Check for partial word matches (at least 3 characters)
          if (word1 !== '' && word1.length >= 3) {
            words2.forEach(word2 => {
              if (
                word2 !== '' &&
                word2.length >= 3 &&
                word1 !== '' &&
                (word1.includes(word2) || word2.includes(word1))
              ) {
                partialMatches++;
              }
            });
          }
        }
      });

      const totalWords = Math.max(words1.length, words2.length);
      const exactScore = commonWords / totalWords;
      const partialScore = (partialMatches / totalWords) * 0.5;

      return Math.min(1.0, exactScore + partialScore);
    }
  }

  // Enhanced click implementation with multiple fallback methods
  private _clickElementEnhanced(
    element: HTMLElement,
    button: ClickOptions['button'],
    clickCount: number = 1
  ): void {
    console.log(`🖱️ Executing enhanced click on element`);

    const eventOptions = {
      bubbles: true,
      cancelable: true,
      button: button === 'left' ? 0 : button === 'right' ? 2 : 1,
      detail: clickCount,
    };

    // Maya's approach: try multiple methods for better compatibility
    for (let i = 0; i < clickCount; i++) {
      try {
        // Method 1: Simple events for basic compatibility
        element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
        element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
        element.dispatchEvent(new MouseEvent('click', eventOptions));

        // Method 2: React synthetic event compatibility
        const syntheticEvent = new Event('click', { bubbles: true, cancelable: true });
        element.dispatchEvent(syntheticEvent);

        console.log(`✅ Maya-style click events dispatched`);
      } catch (e) {
        console.log(`⚠️ Some click events failed: ${e}`);
      }
    }
  }

  // Enhanced fill implementation with enhanced event triggering
  private _fillElementEnhanced(
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    value: string,
    triggerEvents: boolean
  ): void {
    console.log(`📝 Executing enhanced fill on element`);

    try {
      if (element.tagName.toLowerCase() === 'select') {
        const selectElement = element as HTMLSelectElement;
        const option = Array.from(selectElement.options).find(
          opt => opt.value === value || opt.textContent === value
        );

        if (option) {
          selectElement.selectedIndex = option.index;
          console.log(`✅ Maya-style select option set`);
        } else {
          throw new AutomationError(`Option not found in select: ${value}`, 'ELEMENT_NOT_FOUND');
        }
      } else {
        // Maya's approach: Clear and set value directly
        element.value = '';
        element.value = value;
        console.log(`✅ Maya-style value set`);
      }

      if (triggerEvents) {
        // Maya's comprehensive event triggering approach
        try {
          // Input event for React compatibility
          const inputEvent = new Event('input', { bubbles: true, cancelable: true });
          element.dispatchEvent(inputEvent);

          // Change event for form validation
          const changeEvent = new Event('change', { bubbles: true, cancelable: true });
          element.dispatchEvent(changeEvent);

          // Blur event to trigger field validation
          const blurEvent = new Event('blur', { bubbles: true, cancelable: true });
          element.dispatchEvent(blurEvent);

          console.log(`✅ Maya-style fill events dispatched`);
        } catch (e) {
          console.log(`⚠️ Some fill events failed: ${e}`);
        }
      }
    } catch (error) {
      console.log(`❌ Maya-style fill failed: ${error}`);
      throw error;
    }
  }

  // Enhanced element finding with improved prioritization and scoring
  private _findElementByDescriptionEnhanced(description: string): HTMLElement | null {
    console.log(`🔍 Starting enhanced element search for: "${description}"`);

    // Try multiple strategies with improved priority ordering
    const doc = document;

    // Strategy 1: Try direct CSS selector if it looks like one
    if (
      description !== '' &&
      (description.includes('#') || description.includes('.') || description.includes('['))
    ) {
      console.log(`🎯 Trying CSS selector approach`);
      try {
        const elements = doc.querySelectorAll(description);
        console.log(`🔍 CSS selector found ${elements.length} elements`);
        if (elements.length > 0) {
          return elements[0] as HTMLElement;
        }
      } catch (e) {
        console.log(`❌ CSS selector failed`);
      }
    }

    // Strategy 2: Enhanced prioritized element search
    // Step 1: Look for actual buttons first (highest priority)
    const buttonElements = Array.from(
      doc.querySelectorAll(
        'button, [role=button], input[type=button], input[type=submit], .btn, .button, [class*="btn"]'
      )
    );
    console.log(`🔍 Found ${buttonElements.length} button elements`);

    // Step 2: Look for form inputs and controls (high priority)
    const formElements = Array.from(
      doc.querySelectorAll('input:not([type=button]):not([type=submit]), textarea, select')
    );
    console.log(`🔍 Found ${formElements.length} form input elements`);

    // Step 3: Look for clickable divs and interactive elements (medium priority)
    const clickableDivs = Array.from(
      doc.querySelectorAll(
        'div[onclick], span[onclick], [role=tab], [role=menuitem], [data-testid], [data-test-id], [data-cy], .tab, .menu-item, .nav-item, [class*="tab"], [class*="click"], [class*="cursor-pointer"], [style*="cursor: pointer"], [style*="cursor:pointer"]'
      )
    );
    console.log(`🔍 Found ${clickableDivs.length} clickable div/span elements`);

    // Step 4: Look for links (medium priority)
    const linkElements = Array.from(doc.querySelectorAll('a[href]'));
    console.log(`🔍 Found ${linkElements.length} link elements`);

    // Step 5: Look for any other potentially clickable elements as fallback (low priority)
    const otherClickable = Array.from(
      doc.querySelectorAll('div, span, p, td, tr, li, h1, h2, h3, h4, h5, h6')
    );
    console.log(`🔍 Found ${otherClickable.length} other potential elements`);

    // Step 6: Manually combine arrays with proper priority ordering
    const allElements: HTMLElement[] = [];

    // Add button elements first (highest priority)
    buttonElements.forEach(element => {
      allElements.push(element as HTMLElement);
    });

    // Add form elements second (high priority)
    formElements.forEach(element => {
      allElements.push(element as HTMLElement);
    });

    // Add clickable divs third (medium priority)
    clickableDivs.forEach(element => {
      allElements.push(element as HTMLElement);
    });

    // Add links fourth (medium priority)
    linkElements.forEach(element => {
      allElements.push(element as HTMLElement);
    });

    // Add other elements last (lowest priority)
    otherClickable.forEach(element => {
      allElements.push(element as HTMLElement);
    });

    const clickableElements = allElements;

    console.log(`🔍 Found ${clickableElements.length} total clickable elements`);

    // Use enhanced similarity scoring to find best match
    let bestElement: HTMLElement | null = null;
    let bestScore = 0.0;

    for (let i = 0; i < clickableElements.length; i++) {
      const element = clickableElements[i];
      if (!element) continue;

      // Enhanced property checking with better fallbacks
      const textContent = element.textContent?.trim() || '';
      const placeholder = (element as HTMLInputElement).placeholder?.trim() || '';
      const ariaLabel = element.getAttribute('aria-label')?.trim() || '';
      const title = element.getAttribute('title')?.trim() || '';
      const value = (element as HTMLInputElement).value?.trim() || '';
      const name = (element as HTMLInputElement).name?.trim() || '';

      // Calculate similarity scores for all relevant properties
      const textScore = this._calculateExactSimilarity(description, textContent);
      const placeholderScore = this._calculateExactSimilarity(description, placeholder);
      const ariaScore = this._calculateExactSimilarity(description, ariaLabel);
      const titleScore = this._calculateExactSimilarity(description, title);
      const valueScore = this._calculateExactSimilarity(description, value);
      const nameScore = this._calculateExactSimilarity(description, name);

      // Take the highest score from any property
      const maxScore = Math.max(
        textScore,
        placeholderScore,
        ariaScore,
        titleScore,
        valueScore,
        nameScore
      );

      // Get element details for scoring adjustments
      const tagName = element.tagName?.toLowerCase() || 'unknown';
      const id = element.id || '';
      const className = element.className || '';

      // Enhanced size penalty calculation
      const textLength = textContent.length;
      let sizeAdjustedScore: number;
      if (textLength > 1000) {
        // Very heavy penalty for extremely large text content (likely page containers)
        sizeAdjustedScore = maxScore * 0.05;
      } else if (textLength > 500) {
        // Heavy penalty for very large text content (likely page containers)
        sizeAdjustedScore = maxScore * 0.1;
      } else if (textLength > 100) {
        // Moderate penalty for large text content
        sizeAdjustedScore = maxScore * 0.6;
      } else {
        sizeAdjustedScore = maxScore;
      }

      // Enhanced bonus system for different element types
      let adjustedScore: number;
      if (
        tagName === 'button' ||
        (tagName === 'input' && ['button', 'submit'].includes((element as HTMLInputElement).type))
      ) {
        // High bonus for actual buttons
        adjustedScore = sizeAdjustedScore * 1.5;
      } else if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
        // Bonus for form inputs
        adjustedScore = sizeAdjustedScore * 1.3;
      } else if (tagName === 'a' && (element as HTMLAnchorElement).href) {
        // Bonus for actual links
        adjustedScore = sizeAdjustedScore * 1.2;
      } else if (element.hasAttribute('onclick') || element.getAttribute('role') === 'button') {
        // Bonus for elements with click handlers or button role
        adjustedScore = sizeAdjustedScore * 1.2;
      } else if (
        tagName === 'div' &&
        textLength < 50 &&
        (className.includes('btn') || className.includes('click') || className.includes('button'))
      ) {
        // Small divs with button-like classes are likely clickable elements
        adjustedScore = sizeAdjustedScore * 1.1;
      } else {
        adjustedScore = sizeAdjustedScore;
      }

      // Log each element being checked for debugging (only if score > 0)
      if (adjustedScore > 0) {
        const matchReason =
          textScore > 0
            ? 'text'
            : placeholderScore > 0
              ? 'placeholder'
              : ariaScore > 0
                ? 'aria-label'
                : titleScore > 0
                  ? 'title'
                  : valueScore > 0
                    ? 'value'
                    : 'name';
        console.log(
          `🔍 Element ${i}: ${tagName} text="${textContent.slice(0, 30)}..." id="${id}" score=${adjustedScore.toFixed(3)} (${matchReason}) original=${maxScore.toFixed(3)}`
        );
      }

      // Accept if score is above threshold (lowered to 0.15) and better than current best
      if (adjustedScore > 0.15 && adjustedScore > bestScore) {
        bestElement = element;
        bestScore = adjustedScore;
        console.log(
          `🎯 Better match found: score ${adjustedScore.toFixed(3)} for ${tagName} with text="${textContent.slice(0, 30)}..."`
        );
      }

      // If we find an excellent match, stop searching
      if (adjustedScore >= 0.9) {
        bestElement = element;
        bestScore = adjustedScore;
        console.log(`🎯 Found excellent match, stopping search`);
        break;
      }
    }

    if (bestElement) {
      console.log(`✅ Best element found with score: ${bestScore.toFixed(3)}`);
    } else {
      console.log(`❌ No suitable element found for: ${description}`);
    }

    return bestElement;
  }

  // Enhanced exact similarity calculation with improved matching logic
  private _calculateExactSimilarity(text1: string, text2: string): number {
    // Extra safety checks for null/undefined inputs with better handling
    const safeText1 = text1 ? text1.toString().toLowerCase().trim() : '';
    const safeText2 = text2 ? text2.toString().toLowerCase().trim() : '';

    // If either string is empty, no match
    if (safeText1 === '' || safeText2 === '') {
      return 0.0;
    } else if (safeText1 === safeText2) {
      return 1.0;
    } else if (safeText1.includes(safeText2) || safeText2.includes(safeText1)) {
      // Higher score for substring matches with length consideration
      const longer = safeText1.length > safeText2.length ? safeText1 : safeText2;
      const shorter = safeText1.length <= safeText2.length ? safeText1 : safeText2;
      const coverage = shorter.length / longer.length;
      return Math.max(0.7, 0.9 * coverage); // Scale based on how much of the longer string is covered
    } else {
      // Enhanced word-based similarity with better partial matching
      const words1 = safeText1.split(/\s+/).filter(w => w !== '');
      const words2 = safeText2.split(/\s+/).filter(w => w !== '');

      if (words1.length === 0 || words2.length === 0) {
        return 0.0;
      }

      let commonWords = 0;
      let partialMatches = 0;
      let weightedScore = 0;

      words1.forEach(word1 => {
        let bestWordMatch = 0;

        words2.forEach(word2 => {
          // Check for exact word matches
          if (word1 === word2) {
            commonWords++;
            bestWordMatch = Math.max(bestWordMatch, 1.0);
          } else if (word1 !== '' && word2 !== '' && word1.length >= 3 && word2.length >= 3) {
            // Check for partial word matches with better scoring
            if (word1.includes(word2) || word2.includes(word1)) {
              const longer = word1.length > word2.length ? word1 : word2;
              const shorter = word1.length <= word2.length ? word1 : word2;
              const partialScore = shorter.length / longer.length;
              bestWordMatch = Math.max(bestWordMatch, partialScore * 0.7);
              partialMatches++;
            }
          }
        });

        weightedScore += bestWordMatch;
      });

      const totalWords = Math.max(words1.length, words2.length);
      const exactScore = commonWords / totalWords;
      const partialScore = (partialMatches / totalWords) * 0.3;
      const weightedAverage = weightedScore / words1.length;

      // Combine different scoring methods for better accuracy
      return Math.min(1.0, Math.max(exactScore, partialScore, weightedAverage));
    }
  }
}
