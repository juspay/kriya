import type {
  AutomationConfig,
  ContextCaptureConfig,
  ElementContext,
  EventCallback,
  EventType,
  PageContext,
  ScreenshotOptions,
  ViewportInfo,
} from '@/types';
import { DEFAULT_CONTEXT_CAPTURE_CONFIG } from '@/types';
import { AutomationError } from '@/types';
import html2canvas from 'html2canvas';

export class ContextCapture {
  private readonly _config: AutomationConfig;
  private readonly _captureConfig: ContextCaptureConfig;
  private _initialized: boolean;
  public addEventListener: ((eventType: EventType, callback: EventCallback) => void) | null;

  constructor(config: AutomationConfig) {
    this._config = config;
    this._captureConfig = { ...DEFAULT_CONTEXT_CAPTURE_CONFIG };
    this._initialized = false;
    this.addEventListener = null;
  }

  public initialize(): void {
    if (this._initialized) {
      throw new AutomationError(
        'ContextCapture is already initialized',
        'INVALID_CONFIGURATION'
      );
    }

    this._ensureBrowserSupport();
    this._initialized = true;
  }

  public async capturePageContext(): Promise<PageContext> {
    this._ensureInitialized();

    try {
      const viewport = this._getViewportInfo();
      const elements = this._captureConfig.includeElementData 
        ? this._extractElementContext() 
        : [];

      const context: PageContext = {
        pageUrl: window.location.href,
        title: document.title,
        timestamp: Date.now(),
        totalFormsFound: document.querySelectorAll('form').length,
        forms: [], // Will be populated by FormRegistry
        elements,
        viewport,
      };

      if (this.addEventListener) {
        this.addEventListener('context_captured', (() => {}) as EventCallback);
      }

      return context;
    } catch (error) {
      throw new AutomationError(
        `Failed to capture page context: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'EXECUTION_FAILED',
        { originalError: error }
      );
    }
  }

  public async captureScreenshot(options: Partial<ScreenshotOptions> = {}): Promise<string> {
    this._ensureInitialized();

    if (!this._captureConfig.includeScreenshot) {
      throw new AutomationError(
        'Screenshot capture is disabled in configuration',
        'INVALID_CONFIGURATION'
      );
    }

    const screenshotOptions: ScreenshotOptions = {
      fullPage: true,
      quality: 0.9,
      format: 'png',
      ...options,
    };

    try {
      const canvas = await this._captureScreenshotInternal(screenshotOptions);
      const dataUrl = canvas.toDataURL(`image/${screenshotOptions.format}`, screenshotOptions.quality);

      if (this.addEventListener) {
        this.addEventListener('screenshot_taken', (() => {}) as EventCallback);
      }

      return dataUrl;
    } catch (error) {
      throw new AutomationError(
        `Screenshot capture failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'SCREENSHOT_FAILED',
        { options: screenshotOptions, originalError: error }
      );
    }
  }

  public async captureFullPageScreenshot(): Promise<string> {
    return this.captureScreenshot({
      fullPage: true,
      quality: 0.9,
      format: 'png',
    });
  }

  public getViewportInfo(): ViewportInfo {
    this._ensureInitialized();
    return this._getViewportInfo();
  }

  public extractElementContext(): readonly ElementContext[] {
    this._ensureInitialized();
    return this._extractElementContext();
  }

  public dispose(): void {
    this._initialized = false;
    this.addEventListener = null;
  }

  private _ensureInitialized(): void {
    if (!this._initialized) {
      throw new AutomationError(
        'ContextCapture must be initialized before use',
        'INVALID_CONFIGURATION'
      );
    }
  }

  private _ensureBrowserSupport(): void {
    if (typeof window === 'undefined') {
      throw new AutomationError(
        'ContextCapture requires a browser environment',
        'BROWSER_NOT_SUPPORTED'
      );
    }

    if (typeof document === 'undefined') {
      throw new AutomationError(
        'ContextCapture requires DOM access',
        'BROWSER_NOT_SUPPORTED'
      );
    }
  }

  private async _captureScreenshotInternal(options: ScreenshotOptions): Promise<HTMLCanvasElement> {
    const targetElement = options.fullPage ? document.body : document.documentElement;

    const html2canvasOptions = {
      allowTaint: true,
      useCORS: true,
      scale: 1,
      logging: false,
      width: options.clip?.width,
      height: options.clip?.height,
      x: options.clip?.x,
      y: options.clip?.y,
    };

    return html2canvas(targetElement, html2canvasOptions);
  }

  private _getViewportInfo(): ViewportInfo {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX || window.pageXOffset,
      scrollY: window.scrollY || window.pageYOffset,
    };
  }

  private _extractElementContext(): readonly ElementContext[] {
    const elements: ElementContext[] = [];
    const allElements = document.querySelectorAll('*');
    const maxElements = this._captureConfig.maxElementsPerPage;

    let count = 0;
    for (const element of allElements) {
      if (count >= maxElements) break;

      const htmlElement = element as HTMLElement;
      
      if (this._shouldIncludeElement(htmlElement)) {
        const context = this._createElementContext(htmlElement);
        elements.push(context);
        count++;
      }
    }

    return elements;
  }

  private _shouldIncludeElement(element: HTMLElement): boolean {
    const tagName = element.tagName.toLowerCase();
    
    // Include interactive elements
    const interactiveTags = ['a', 'button', 'input', 'textarea', 'select', 'form'];
    if (interactiveTags.includes(tagName)) {
      return true;
    }

    // Include elements with significant text content
    const textContent = element.textContent?.trim() ?? '';
    if (textContent.length > 5 && textContent.length < 200) {
      return true;
    }

    // Include elements with specific attributes
    const hasId = element.id && element.id.length > 0;
    const hasClass = element.className && element.className.length > 0;
    const hasAriaLabel = element.getAttribute('aria-label');
    
    if (hasId || hasAriaLabel) {
      return true;
    }

    // Skip hidden or very small elements
    const rect = element.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    return false;
  }

  private _createElementContext(element: HTMLElement): ElementContext {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    
    const isVisible = style.display !== 'none' && 
                     style.visibility !== 'hidden' && 
                     rect.width > 0 && 
                     rect.height > 0;

    const isClickable = this._isElementClickable(element);

    return {
      tagName: element.tagName.toLowerCase(),
      id: element.id || undefined,
      className: element.className || undefined,
      textContent: element.textContent?.trim() || undefined,
      type: (element as HTMLInputElement).type || undefined,
      value: (element as HTMLInputElement).value || undefined,
      href: (element as HTMLAnchorElement).href || undefined,
      clickable: isClickable,
      visible: isVisible,
    };
  }

  private _isElementClickable(element: HTMLElement): boolean {
    const tagName = element.tagName.toLowerCase();
    const clickableTags = ['a', 'button', 'input', 'select', 'textarea'];
    
    if (clickableTags.includes(tagName)) {
      return true;
    }

    // Check for click event listeners (basic check)
    const hasClickHandler = element.onclick !== null ||
                           element.getAttribute('onclick') !== null;

    if (hasClickHandler) {
      return true;
    }

    // Check for cursor pointer
    const style = window.getComputedStyle(element);
    if (style.cursor === 'pointer') {
      return true;
    }

    // Check for role attribute
    const role = element.getAttribute('role');
    if (role === 'button' || role === 'link') {
      return true;
    }

    return false;
  }
}