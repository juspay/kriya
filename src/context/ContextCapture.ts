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
  private _formRegistry: any = null;
  public addEventListener: ((eventType: EventType, callback: EventCallback) => void) | null;

  constructor(config: AutomationConfig) {
    this._config = config;
    this._captureConfig = { ...DEFAULT_CONTEXT_CAPTURE_CONFIG };
    this._initialized = false;
    this.addEventListener = null;
  }

  public setFormRegistry(formRegistry: any): void {
    this._formRegistry = formRegistry;
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

      // Enhanced form detection for both FormRegistry and custom design system
      let forms: any[] = [];
      
      // First, try to get forms from FormRegistry
      if (this._formRegistry && typeof this._formRegistry.getFormContext === 'function') {
        try {
          forms = this._formRegistry.getFormContext();
          console.log(`📋 Kriya: Found ${forms.length} forms from FormRegistry`);
        } catch (error) {
          console.warn('📋 Kriya: Failed to get forms from FormRegistry:', error);
        }
      }
      
      // Always also detect custom design system components (whether or not FormRegistry found forms)
      const customForms = this._detectCustomDesignSystemForms();
      console.log(`📋 Kriya: Detected ${customForms.length} custom design system forms`);
      
      // Combine forms from both sources
      forms = forms.concat(customForms);

      const context: PageContext = {
        pageUrl: window.location.href,
        title: document.title,
        timestamp: Date.now(),
        totalFormsFound: Math.max(document.querySelectorAll('form').length, forms.length),
        forms: forms,
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

  private _detectCustomDesignSystemForms(): any[] {
    console.log('📋 Kriya: Starting custom design system form detection...');
    
    const forms: any[] = [];
    
    // Find all field wrappers (form containers)
    const fieldWrappers = document.querySelectorAll('[data-component-field-wrapper]');
    
    if (fieldWrappers.length > 0) {
      console.log(`📋 Kriya: Found ${fieldWrappers.length} field wrappers`);
      
      // Debug: Log each wrapper found
      fieldWrappers.forEach((wrapper, index) => {
        const wrapperName = wrapper.getAttribute('data-component-field-wrapper');
        console.log(`📋 Kriya: Wrapper ${index}: ${wrapperName}`);
      });
      
      // Group field wrappers into logical forms
      const detectedFields = Array.from(fieldWrappers).map((wrapper, index) => {
        const field = this._extractCustomFieldInfo(wrapper as HTMLElement, index);
        if (!field) {
          console.log(`📋 Kriya: Failed to extract field from wrapper ${index}`);
        }
        return field;
      }).filter(field => field !== null);
      
      console.log(`📋 Kriya: Successfully extracted ${detectedFields.length} fields from wrappers`);
      
      if (detectedFields.length > 0) {
        // Create a single form containing all detected fields
        forms.push({
          formId: 'custom-design-system-form',
          action: window.location.href,
          method: 'POST',
          fields: detectedFields,
          isRegistered: false,
          hasSubmitButton: this._hasCustomSubmitButton(),
        });
      }
    }
    
    // Always also check for additional fallback fields that might not be in wrappers
    const fallbackFields = this._detectFallbackFields();
    console.log(`📋 Kriya: Found ${fallbackFields.length} fallback fields`);
    
    if (fallbackFields.length > 0) {
      // Only add fallback fields that weren't already captured in wrappers
      const existingFieldNames = forms.flatMap(form => form.fields.map((field: any) => field.name));
      const uniqueFallbackFields = fallbackFields.filter((field: any) => 
        !existingFieldNames.includes(field.name)
      );
      
      console.log(`📋 Kriya: ${uniqueFallbackFields.length} unique fallback fields after deduplication`);
      
      if (uniqueFallbackFields.length > 0) {
        forms.push({
          formId: 'fallback-design-system-form',
          action: window.location.href,
          method: 'POST',
          fields: uniqueFallbackFields,
          isRegistered: false,
          hasSubmitButton: this._hasCustomSubmitButton(),
        });
      }
    }
    
    console.log(`📋 Kriya: Custom detection complete - found ${forms.length} forms with ${forms.reduce((total, form) => total + form.fields.length, 0)} total fields`);
    return forms;
  }

  private _extractCustomFieldInfo(wrapper: HTMLElement, index: number): any | null {
    const fieldName = wrapper.getAttribute('data-component-field-wrapper') || `field-${index}`;
    
    // Find label
    const labelElement = wrapper.querySelector('[data-form-label]');
    const label = labelElement?.getAttribute('data-form-label') || 
                  labelElement?.textContent?.trim() || 
                  undefined;
    
    // Detect field type and extract value
    const fieldInfo = this._detectFieldTypeAndValue(wrapper);
    
    if (!fieldInfo) {
      console.log(`📋 Kriya: Could not determine field type for ${fieldName}`);
      return null;
    }
    
    console.log(`📋 Kriya: Extracted field "${fieldName}" - type: ${fieldInfo.type}, value: "${fieldInfo.value}"`);
    
    return {
      name: fieldName,
      type: fieldInfo.type,
      value: fieldInfo.value,
      placeholder: fieldInfo.placeholder,
      required: fieldInfo.required || false,
      disabled: fieldInfo.disabled || false,
      label: label,
      options: fieldInfo.options || undefined,
    };
  }

  private _detectFieldTypeAndValue(wrapper: HTMLElement): any | null {
    // Check for SelectBox/Dropdown
    const selectboxValue = wrapper.querySelector('[data-selectbox-value]');
    if (selectboxValue) {
      const buttonText = selectboxValue.getAttribute('data-selectbox-value') || '';
      
      // Find the actual selected value from the button
      const selectedButton = wrapper.querySelector('button[data-value]');
      const currentValue = selectedButton?.getAttribute('data-value') || '';
      const displayText = wrapper.querySelector('[data-button-text]')?.textContent?.trim() || '';
      
      // Look for dropdown options when dropdown is expanded
      const dropdown = wrapper.querySelector('[data-dropdown="dropdown"]');
      const options: string[] = [];
      
      if (dropdown) {
        const optionElements = dropdown.querySelectorAll('[data-dropdown-value]');
        optionElements.forEach(option => {
          const value = option.getAttribute('data-dropdown-value');
          if (value) options.push(value);
        });
      } else {
        // If dropdown is not expanded, try to find options from static elements
        const allButtons = wrapper.querySelectorAll('button[data-value]');
        allButtons.forEach(button => {
          const value = button.getAttribute('data-value');
          if (value) options.push(value);
        });
      }
      
      return {
        type: 'select',
        value: currentValue,
        displayText: displayText,
        buttonText: buttonText,
        placeholder: buttonText,
        options: options.length > 0 ? options : undefined,
      };
    }
    
    // Check for standard input elements within the wrapper
    const inputElement = wrapper.querySelector('input, textarea');
    if (inputElement) {
      const input = inputElement as HTMLInputElement | HTMLTextAreaElement;
      return {
        type: input.type || 'text',
        value: input.value || '',
        placeholder: (input as HTMLInputElement).placeholder || undefined,
        required: input.required,
        disabled: input.disabled,
      };
    }
    
    // Check for button-based inputs (like date pickers, file uploads)
    const buttonInput = wrapper.querySelector('button[data-value]');
    if (buttonInput) {
      const value = buttonInput.getAttribute('data-value') || '';
      const buttonText = buttonInput.querySelector('[data-button-text]')?.textContent?.trim() || '';
      
      return {
        type: 'button',
        value: value,
        placeholder: buttonText,
      };
    }
    
    // Check for numeric inputs or specialized inputs
    const numericInput = wrapper.querySelector('[inputmode="numeric"], [type="number"]');
    if (numericInput) {
      const input = numericInput as HTMLInputElement;
      return {
        type: 'number',
        value: input.value || '',
        placeholder: input.placeholder || undefined,
        required: input.required,
        disabled: input.disabled,
      };
    }
    
    return null;
  }

  private _detectFallbackFields(): any[] {
    const fields: any[] = [];
    
    // Look for SelectBox components with proper value extraction
    const selectBoxElements = document.querySelectorAll('[data-selectbox-value]');
    selectBoxElements.forEach((element, index) => {
      const buttonText = element.getAttribute('data-selectbox-value') || '';
      
      // Find the actual selected value
      const selectedButton = element.querySelector('button[data-value]');
      const currentValue = selectedButton?.getAttribute('data-value') || '';
      const displayText = element.querySelector('[data-button-text]')?.textContent?.trim() || '';
      
      // Try to find a meaningful field name from the wrapper or label
      const wrapper = element.closest('[data-component-field-wrapper]');
      const label = element.querySelector('[data-form-label]');
      const fieldName = wrapper?.getAttribute('data-component-field-wrapper') || 
                       label?.getAttribute('data-form-label') || 
                       `selectbox-${index}`;
      
      fields.push({
        name: fieldName,
        type: 'select',
        value: currentValue,
        displayText: displayText,
        buttonText: buttonText,
        placeholder: buttonText,
        required: false,
        disabled: selectedButton?.hasAttribute('disabled') || false,
        label: label?.textContent?.trim() || undefined,
      });
    });
    
    // Look for other design system inputs
    const inputs = document.querySelectorAll('[data-design-system="true"] input, [data-design-system="true"] textarea');
    inputs.forEach((element, index) => {
      const input = element as HTMLInputElement | HTMLTextAreaElement;
      
      // Try to find a meaningful field name from the wrapper or nearby label
      const wrapper = input.closest('[data-component-field-wrapper]');
      const label = wrapper?.querySelector('[data-form-label]') || 
                   document.querySelector(`label[for="${input.id}"]`);
      const fieldName = wrapper?.getAttribute('data-component-field-wrapper') || 
                       input.name || 
                       input.id || 
                       label?.getAttribute('data-form-label') ||
                       `input-${index}`;
      
      fields.push({
        name: fieldName,
        type: input.type || 'text',
        value: input.value || '',
        placeholder: (input as HTMLInputElement).placeholder || undefined,
        required: input.required,
        disabled: input.disabled,
        label: label?.textContent?.trim() || undefined,
      });
    });
    
    return fields;
  }

  private _hasCustomSubmitButton(): boolean {
    // Look for common submit button patterns
    const submitButtons = document.querySelectorAll(
      'button[type="submit"], [data-button-type="submit"], button:contains("Submit"), button:contains("Save"), button:contains("Apply")'
    );
    return submitButtons.length > 0;
  }
}
