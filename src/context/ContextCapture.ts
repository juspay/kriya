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
    console.log('📋 Kriya: Starting ReScript Euler dashboard form detection...');
    
    const forms: any[] = [];
    const processedElements = new Set<HTMLElement>();
    
    // Detect ReScript FormRenderer fields - this is the primary pattern
    const rescriptFields = this._detectReScriptFormRendererFields(processedElements);
    console.log(`📋 Kriya: Found ${rescriptFields.length} ReScript FormRenderer fields`);
    
    if (rescriptFields.length > 0) {
      forms.push({
        formId: 'rescript-form-renderer-form',
        action: window.location.href,
        method: 'POST',
        fields: rescriptFields,
        isRegistered: false,
        hasSubmitButton: this._hasReScriptSubmitButton(),
        framework: 'ReScript + React Final Form',
      });
    }
    
    // Detect standalone React Final Form inputs (only those NOT already detected in ReScript forms)
    const reactFinalFormFields = this._detectReactFinalFormFields(processedElements);
    console.log(`📋 Kriya: Found ${reactFinalFormFields.length} standalone React Final Form fields`);
    
    if (reactFinalFormFields.length > 0) {
      const existingFieldNames = forms.flatMap(form => form.fields.map((field: any) => field.name));
      const uniqueFormFields = reactFinalFormFields.filter((field: any) => 
        !existingFieldNames.includes(field.name) && 
        !this._isFieldNameSimilar(field.name, existingFieldNames)
      );
      
      if (uniqueFormFields.length > 0) {
        forms.push({
          formId: 'react-final-form-fields',
          action: window.location.href,
          method: 'POST',
          fields: uniqueFormFields,
          isRegistered: false,
          hasSubmitButton: this._hasReScriptSubmitButton(),
          framework: 'React Final Form',
        });
      }
    }
    
    console.log(`📋 Kriya: ReScript detection complete - found ${forms.length} forms with ${forms.reduce((total, form) => total + form.fields.length, 0)} total fields`);
    return forms;
  }

  private _extractCustomFieldInfo(wrapper: HTMLElement, index: number): any | null {
    // Try multiple strategies to get a meaningful field name
    const fieldName = this._extractFieldName(wrapper, index);
    
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
      'button[type="submit"], [data-button-type="submit"]'
    );
    
    // Also check for buttons with submit-related text content
    const allButtons = document.querySelectorAll('button');
    const textBasedSubmitButtons = Array.from(allButtons).filter(button => {
      const text = button.textContent?.toLowerCase() || '';
      return text.includes('submit') || 
             text.includes('save') || 
             text.includes('apply');
    });
    
    return submitButtons.length > 0 || textBasedSubmitButtons.length > 0;
  }

  // ReScript-specific form detection methods
  private _detectReScriptFormRendererFields(processedElements: Set<HTMLElement> = new Set()): any[] {
    const fields: any[] = [];
    console.log('📋 Kriya: Starting comprehensive ReScript InputFields detection...');
    
    // Comprehensive detection for all InputFields.res patterns
    
    // 1. Detect Euler Dashboard Field Wrappers (Primary Pattern)
    const fieldWrappers = document.querySelectorAll('[data-component-field-wrapper]');
    console.log(`📋 Kriya: Found ${fieldWrappers.length} field wrappers`);
    
    fieldWrappers.forEach((wrapper, index) => {
      const fieldName = this._extractFieldName(wrapper as HTMLElement, index);
      const labelElement = wrapper.querySelector('[data-form-label]');
      const label = labelElement?.getAttribute('data-form-label') || labelElement?.textContent?.trim() || '';
      
      // Detect field type and extract comprehensive information
      const fieldInfo = this._detectComprehensiveFieldType(wrapper as HTMLElement, fieldName, label);
      if (fieldInfo) {
        fields.push(fieldInfo);
        console.log(`📋 Kriya: Detected field "${fieldName}" - ${fieldInfo.type}`);
      }
    });
    
    // 2. Detect standalone React Final Form inputs
    const formInputs = document.querySelectorAll('input[name], select[name], textarea[name]');
    console.log(`📋 Kriya: Found ${formInputs.length} standard form inputs`);
    
    formInputs.forEach((element, index) => {
      const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      
      // Skip if already detected in field wrapper
      if (input.closest('[data-component-field-wrapper]')) {
        return;
      }
      
      // Check if this is part of a React Final Form
      const formContainer = input.closest('form') || input.closest('[data-rff-ui]') || input.closest('[class*="form"]');
      
      if (formContainer && input.name) {
        const fieldInfo = this._extractStandardFieldInfo(input, index);
        if (fieldInfo) {
          fields.push(fieldInfo);
          console.log(`📋 Kriya: Detected standard field "${fieldInfo.name}" - ${fieldInfo.type}`);
        }
      }
    });
    
    // 3. Detect specialized ReScript components that don't use standard HTML inputs
    const specializedFields = this._detectSpecializedReScriptComponents();
    fields.push(...specializedFields);
    
    console.log(`📋 Kriya: Total ReScript fields detected: ${fields.length}`);
    return fields;
  }

  private _detectReScriptSelectBoxFields(): any[] {
    const fields: any[] = [];
    
    // Primary detection: Look for Euler dashboard SelectBox pattern with data attributes
    const eulerSelectBoxes = document.querySelectorAll('[data-selectbox-value]');
    
    eulerSelectBoxes.forEach((element, index) => {
      console.log(`📋 Kriya: Found Euler selectbox ${index}:`, element);
      
      // Get field wrapper for field name
      const fieldWrapper = element.closest('[data-component-field-wrapper]');
      const fieldName = fieldWrapper?.getAttribute('data-component-field-wrapper') || `euler-selectbox-${index}`;
      
      // Get label from data-form-label
      const labelElement = fieldWrapper?.querySelector('[data-form-label]');
      const label = labelElement?.getAttribute('data-form-label') || labelElement?.textContent?.trim() || '';
      
      // Get button and current value
      const button = element.querySelector('button[data-value]') as HTMLButtonElement;
      if (button) {
        const currentValue = button.getAttribute('data-value') || '';
        
        // Get button text (displayed value)
        const buttonTextElement = button.querySelector('[data-button-text]');
        const displayText = buttonTextElement?.getAttribute('data-button-text') || 
                           buttonTextElement?.textContent?.trim() || '';
        
        // Get selectbox placeholder/title
        const selectboxTitle = element.getAttribute('data-selectbox-value') || '';
        
        // Check if required (look for red asterisk)
        const isRequired = fieldWrapper?.querySelector('.text-red-950') !== null;
        
        console.log(`📋 Kriya: Euler selectbox details - Name: ${fieldName}, Label: ${label}, Value: ${currentValue}, Display: ${displayText}`);
        
        fields.push({
          name: fieldName,
          type: 'euler-selectbox',
          value: currentValue,
          displayText: displayText,
          label: label || undefined,
          placeholder: selectboxTitle,
          required: isRequired,
          disabled: button.disabled || button.getAttribute('data-button-status') === 'disabled',
          framework: 'Euler ReScript SelectBox',
          dataAttributes: {
            'data-selectbox-value': selectboxTitle,
            'data-component-field-wrapper': fieldName,
            'data-form-label': label,
          }
        });
      }
    });
    
    // Fallback: Look for SelectBox components by class patterns (for other implementations)
    const classBasedSelectBoxes = document.querySelectorAll(
      '[class*="selectbox"], [class*="dropdown"], [class*="select-box"], button[role="combobox"], [aria-haspopup="listbox"]'
    );
    
    classBasedSelectBoxes.forEach((element, index) => {
      // Skip if already detected by data attribute method
      if (element.closest('[data-selectbox-value]')) {
        return;
      }
      
      const button = element.tagName.toLowerCase() === 'button' ? element as HTMLButtonElement : 
                    element.querySelector('button') as HTMLButtonElement;
      
      if (button) {
        const buttonText = button.textContent?.trim() || '';
        const fieldName = element.getAttribute('data-name') || 
                         element.id || 
                         button.getAttribute('aria-label') ||
                         `class-selectbox-${index}`;
        
        // Look for current value in data attributes
        let currentValue = button.getAttribute('data-value') || 
                          button.getAttribute('value') || 
                          '';
        
        // If no data-value, use button text as current value (but exclude placeholder-like text)
        if (!currentValue && buttonText && 
            !buttonText.toLowerCase().includes('select') && 
            !buttonText.toLowerCase().includes('choose')) {
          currentValue = buttonText;
        }
        
        // Find dropdown options
        const options: string[] = [];
        const dropdownContainer = element.querySelector('[role="listbox"], [class*="dropdown"], [class*="options"]');
        
        if (dropdownContainer) {
          const optionElements = dropdownContainer.querySelectorAll('[role="option"], [data-value], li, div[class*="option"]');
          optionElements.forEach(option => {
            const optionValue = option.getAttribute('data-value') || 
                               option.textContent?.trim() || 
                               '';
            if (optionValue && !options.includes(optionValue)) {
              options.push(optionValue);
            }
          });
        }
        
        // Try to find label
        const label = element.querySelector('label')?.textContent?.trim() ||
                     element.getAttribute('aria-label') ||
                     '';
        
        fields.push({
          name: fieldName,
          type: 'class-selectbox',
          value: currentValue,
          label: label || undefined,
          placeholder: buttonText,
          required: false,
          disabled: button.disabled,
          options: options.length > 0 ? options : undefined,
          framework: 'Generic ReScript SelectBox',
        });
      }
    });
    
    return fields;
  }

  private _detectReactFinalFormFields(processedElements: Set<HTMLElement> = new Set()): any[] {
    const fields: any[] = [];
    
    // Look for React Final Form field patterns
    const formElements = document.querySelectorAll('input, select, textarea');
    
    formElements.forEach((element, index) => {
      const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      
      // Check if this element has React Final Form characteristics
      const hasRFFCharacteristics = input.name || // Has name attribute (required for RFF)
                                   input.closest('[data-rff-ui]') || // Explicit RFF marker
                                   input.closest('form') || // Inside a form
                                   input.hasAttribute('data-rff-field'); // Explicit field marker
      
      if (hasRFFCharacteristics) {
        const fieldName = this._extractInputFieldName(input, index);
        let fieldType = 'text';
        let currentValue = '';
        let options: string[] = [];
        
        if (input.tagName.toLowerCase() === 'select') {
          fieldType = 'select';
          const selectElement = input as HTMLSelectElement;
          currentValue = selectElement.value;
          
          Array.from(selectElement.options).forEach(option => {
            if (option.value) {
              options.push(option.value);
            }
          });
          
        } else if (input.tagName.toLowerCase() === 'textarea') {
          fieldType = 'textarea';
          currentValue = input.value;
          
        } else {
          const inputElement = input as HTMLInputElement;
          fieldType = inputElement.type || 'text';
          currentValue = inputElement.value;
        }
        
        // Find label
        const labelElement = document.querySelector(`label[for="${input.id}"]`) ||
                           input.closest('label') ||
                           input.parentElement?.querySelector('label');
        
        const label = labelElement?.textContent?.trim() || '';
        
        fields.push({
          name: fieldName,
          type: fieldType,
          value: currentValue,
          label: label || undefined,
          placeholder: (input as HTMLInputElement).placeholder || undefined,
          required: input.required || false,
          disabled: input.disabled || false,
          options: options.length > 0 ? options : undefined,
          framework: 'React Final Form',
        });
      }
    });
    
    return fields;
  }

  private _hasReScriptSubmitButton(): boolean {
    // Look for submit buttons with ReScript/React patterns
    const submitButtons = document.querySelectorAll(
      'button[type="submit"],' +
      'button[class*="submit"],' +
      'button[class*="primary"],' +
      'input[type="submit"],' +
      '[data-button-type="submit"]'
    );
    
    // Also check for buttons with submit-related text content
    const allButtons = document.querySelectorAll('button');
    const textBasedSubmitButtons = Array.from(allButtons).filter(button => {
      const text = button.textContent?.toLowerCase() || '';
      return text.includes('submit') || 
             text.includes('save') || 
             text.includes('apply') || 
             text.includes('create') || 
             text.includes('update');
    });
    
    return submitButtons.length > 0 || textBasedSubmitButtons.length > 0;
  }

  // Comprehensive field type detection for all InputFields.res patterns
  private _detectComprehensiveFieldType(wrapper: HTMLElement, fieldName: string, label: string): any | null {
    // Check for SelectBox/MultiSelectBox (most common in Euler dashboard)
    const selectboxValue = wrapper.querySelector('[data-selectbox-value]');
    if (selectboxValue) {
      return this._extractSelectBoxInfo(wrapper, fieldName, label, false);
    }

    // Check for MultiSelectBox with chips
    const multiSelectWithChips = wrapper.querySelector('.selectbox-chips, [data-multiselect="true"]');
    if (multiSelectWithChips) {
      return this._extractSelectBoxInfo(wrapper, fieldName, label, true);
    }

    // Check for TextInput
    const textInput = wrapper.querySelector('input[type="text"], input:not([type])');
    if (textInput) {
      return this._extractTextInputInfo(textInput as HTMLInputElement, fieldName, label);
    }

    // Check for NumericTextInput
    const numericInput = wrapper.querySelector('input[type="number"], input[inputmode="numeric"]');
    if (numericInput) {
      return this._extractNumericInputInfo(numericInput as HTMLInputElement, fieldName, label);
    }

    // Check for MultiLineTextInput (TextArea)
    const textArea = wrapper.querySelector('textarea');
    if (textArea) {
      return this._extractTextAreaInfo(textArea as HTMLTextAreaElement, fieldName, label);
    }

    // Check for DatePicker/DateRangePicker
    const datePicker = wrapper.querySelector('button[data-date-picker], .date-picker');
    if (datePicker) {
      return this._extractDatePickerInfo(wrapper, fieldName, label);
    }

    // Check for FileInput/CsvInput
    const fileInput = wrapper.querySelector('input[type="file"], .file-upload');
    if (fileInput) {
      return this._extractFileInputInfo(wrapper, fieldName, label);
    }

    // Check for BoolInput/Checkbox
    const boolInput = wrapper.querySelector('input[type="checkbox"], input[type="radio"]');
    if (boolInput) {
      return this._extractBoolInputInfo(boolInput as HTMLInputElement, fieldName, label);
    }

    // Check for Button Group Input
    const buttonGroup = wrapper.querySelector('.button-group, [data-button-group]');
    if (buttonGroup) {
      return this._extractButtonGroupInfo(wrapper, fieldName, label);
    }

    // Check for Range/Slider Input
    const rangeInput = wrapper.querySelector('input[type="range"], .range-slider');
    if (rangeInput) {
      return this._extractRangeInputInfo(wrapper, fieldName, label);
    }

    // Check for Color Picker
    const colorPicker = wrapper.querySelector('input[type="color"], .color-picker');
    if (colorPicker) {
      return this._extractColorPickerInfo(wrapper, fieldName, label);
    }

    // Check for MultiTextInput (Tag Input)
    const tagInput = wrapper.querySelector('.tag-input, .chip-input, [data-tag-input]');
    if (tagInput) {
      return this._extractTagInputInfo(wrapper, fieldName, label);
    }

    // Generic button-based input
    const buttonInput = wrapper.querySelector('button[data-value]');
    if (buttonInput) {
      return this._extractButtonInputInfo(wrapper, fieldName, label);
    }

    console.log(`📋 Kriya: Could not determine field type for wrapper "${fieldName}"`);
    return null;
  }

  private _extractSelectBoxInfo(wrapper: HTMLElement, fieldName: string, label: string, isMultiSelect: boolean): any {
    const selectboxElement = wrapper.querySelector('[data-selectbox-value]');
    const selectboxTitle = selectboxElement?.getAttribute('data-selectbox-value') || '';
    
    const button = wrapper.querySelector('button[data-value]') as HTMLButtonElement;
    const currentValue = button?.getAttribute('data-value') || '';
    
    const buttonTextElement = button?.querySelector('[data-button-text]');
    const displayText = buttonTextElement?.getAttribute('data-button-text') || 
                       buttonTextElement?.textContent?.trim() || '';
    
    // Check if required
    const isRequired = wrapper.querySelector('.text-red-950') !== null;
    
    // Look for options in expanded dropdown
    const options: string[] = [];
    const dropdown = wrapper.querySelector('[data-dropdown="dropdown"]');
    if (dropdown) {
      const optionElements = dropdown.querySelectorAll('[data-dropdown-value]');
      optionElements.forEach(option => {
        const value = option.getAttribute('data-dropdown-value');
        if (value) options.push(value);
      });
    }

    // For MultiSelect, check for selected chips
    let selectedValues: string[] = [];
    if (isMultiSelect) {
      const chips = wrapper.querySelectorAll('.chip, .tag, [data-chip-value]');
      chips.forEach(chip => {
        const chipValue = chip.getAttribute('data-chip-value') || chip.textContent?.trim();
        if (chipValue) selectedValues.push(chipValue);
      });
    }

    return {
      name: fieldName,
      type: isMultiSelect ? 'multiselect' : 'select',
      value: isMultiSelect ? selectedValues : currentValue,
      displayText: displayText,
      label: label || undefined,
      placeholder: selectboxTitle,
      required: isRequired,
      disabled: button?.disabled || button?.getAttribute('data-button-status') === 'disabled',
      options: options.length > 0 ? options : undefined,
      framework: 'Euler ReScript SelectBox',
      inputType: 'selectInput',
    };
  }

  private _extractTextInputInfo(input: HTMLInputElement, fieldName: string, label: string): any {
    return {
      name: fieldName,
      type: 'text',
      value: input.value || '',
      label: label || undefined,
      placeholder: input.placeholder || undefined,
      required: input.required,
      disabled: input.disabled,
      maxLength: input.maxLength > 0 ? input.maxLength : undefined,
      framework: 'Euler ReScript TextInput',
      inputType: 'textInput',
    };
  }

  private _extractNumericInputInfo(input: HTMLInputElement, fieldName: string, label: string): any {
    return {
      name: fieldName,
      type: 'number',
      value: input.value || '',
      label: label || undefined,
      placeholder: input.placeholder || undefined,
      required: input.required,
      disabled: input.disabled,
      min: input.min || undefined,
      max: input.max || undefined,
      step: input.step || undefined,
      framework: 'Euler ReScript NumericTextInput',
      inputType: 'numericTextInput',
    };
  }

  private _extractTextAreaInfo(textarea: HTMLTextAreaElement, fieldName: string, label: string): any {
    return {
      name: fieldName,
      type: 'textarea',
      value: textarea.value || '',
      label: label || undefined,
      placeholder: textarea.placeholder || undefined,
      required: textarea.required,
      disabled: textarea.disabled,
      rows: textarea.rows || undefined,
      cols: textarea.cols || undefined,
      maxLength: textarea.maxLength > 0 ? textarea.maxLength : undefined,
      framework: 'Euler ReScript MultiLineTextInput',
      inputType: 'multiLineTextInput',
    };
  }

  private _extractDatePickerInfo(wrapper: HTMLElement, fieldName: string, label: string): any {
    const button = wrapper.querySelector('button') as HTMLButtonElement;
    const currentValue = button?.getAttribute('data-value') || button?.textContent?.trim() || '';
    
    // Check if it's a date range picker
    const isDateRange = wrapper.querySelector('[data-start-date], [data-end-date]') !== null;
    
    return {
      name: fieldName,
      type: isDateRange ? 'daterange' : 'date',
      value: currentValue,
      label: label || undefined,
      placeholder: button?.textContent?.trim() || 'Select Date',
      required: wrapper.querySelector('.text-red-950') !== null,
      disabled: button?.disabled || false,
      framework: 'Euler ReScript DatePicker',
      inputType: isDateRange ? 'dateRangeField' : 'datePickerInput',
    };
  }

  private _extractFileInputInfo(wrapper: HTMLElement, fieldName: string, label: string): any {
    const fileInput = wrapper.querySelector('input[type="file"]') as HTMLInputElement;
    const button = wrapper.querySelector('button');
    
    return {
      name: fieldName,
      type: 'file',
      value: fileInput?.files?.[0]?.name || '',
      label: label || undefined,
      placeholder: button?.textContent?.trim() || 'Choose File',
      required: wrapper.querySelector('.text-red-950') !== null,
      disabled: fileInput?.disabled || button?.disabled || false,
      accept: fileInput?.accept || undefined,
      multiple: fileInput?.multiple || false,
      framework: 'Euler ReScript FileInput',
      inputType: 'fileInput',
    };
  }

  private _extractBoolInputInfo(input: HTMLInputElement, fieldName: string, label: string): any {
    return {
      name: fieldName,
      type: input.type === 'radio' ? 'radio' : 'checkbox',
      value: input.checked,
      label: label || undefined,
      required: input.required,
      disabled: input.disabled,
      framework: 'Euler ReScript BoolInput',
      inputType: input.type === 'radio' ? 'radioInput' : 'boolInput',
    };
  }

  private _extractButtonGroupInfo(wrapper: HTMLElement, fieldName: string, label: string): any {
    const buttons = wrapper.querySelectorAll('button');
    const selectedButton = wrapper.querySelector('button.selected, button[data-selected="true"]');
    const currentValue = selectedButton?.getAttribute('data-value') || 
                        selectedButton?.textContent?.trim() || '';
    
    const options: string[] = [];
    buttons.forEach(button => {
      const value = button.getAttribute('data-value') || button.textContent?.trim();
      if (value) options.push(value);
    });

    return {
      name: fieldName,
      type: 'buttongroup',
      value: currentValue,
      label: label || undefined,
      required: wrapper.querySelector('.text-red-950') !== null,
      disabled: Array.from(buttons).every(btn => btn.disabled),
      options: options,
      framework: 'Euler ReScript ButtonGroup',
      inputType: 'btnGroupInput',
    };
  }

  private _extractRangeInputInfo(wrapper: HTMLElement, fieldName: string, label: string): any {
    const rangeInput = wrapper.querySelector('input[type="range"]') as HTMLInputElement;
    
    return {
      name: fieldName,
      type: 'range',
      value: rangeInput?.value || '',
      label: label || undefined,
      required: wrapper.querySelector('.text-red-950') !== null,
      disabled: rangeInput?.disabled || false,
      min: rangeInput?.min || undefined,
      max: rangeInput?.max || undefined,
      step: rangeInput?.step || undefined,
      framework: 'Euler ReScript RangeInput',
      inputType: 'rangeInput',
    };
  }

  private _extractColorPickerInfo(wrapper: HTMLElement, fieldName: string, label: string): any {
    const colorInput = wrapper.querySelector('input[type="color"]') as HTMLInputElement;
    
    return {
      name: fieldName,
      type: 'color',
      value: colorInput?.value || '#000000',
      label: label || undefined,
      required: wrapper.querySelector('.text-red-950') !== null,
      disabled: colorInput?.disabled || false,
      framework: 'Euler ReScript ColorPicker',
      inputType: 'colorPickerInput',
    };
  }

  private _extractTagInputInfo(wrapper: HTMLElement, fieldName: string, label: string): any {
    const tags: string[] = [];
    const tagElements = wrapper.querySelectorAll('.tag, .chip, [data-tag]');
    
    tagElements.forEach(tag => {
      const tagValue = tag.getAttribute('data-tag') || tag.textContent?.trim();
      if (tagValue) tags.push(tagValue);
    });

    return {
      name: fieldName,
      type: 'tags',
      value: tags,
      label: label || undefined,
      placeholder: wrapper.querySelector('input')?.placeholder || 'Add tags',
      required: wrapper.querySelector('.text-red-950') !== null,
      disabled: wrapper.querySelector('input')?.disabled || false,
      framework: 'Euler ReScript MultiTextInput',
      inputType: 'textTagInput',
    };
  }

  private _extractButtonInputInfo(wrapper: HTMLElement, fieldName: string, label: string): any {
    const button = wrapper.querySelector('button[data-value]') as HTMLButtonElement;
    const currentValue = button?.getAttribute('data-value') || '';
    const displayText = button?.textContent?.trim() || '';

    return {
      name: fieldName,
      type: 'button',
      value: currentValue,
      displayText: displayText,
      label: label || undefined,
      placeholder: displayText,
      required: wrapper.querySelector('.text-red-950') !== null,
      disabled: button?.disabled || false,
      framework: 'Euler ReScript ButtonInput',
      inputType: 'buttonInput',
    };
  }

  private _extractStandardFieldInfo(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, index: number): any | null {
    const fieldName = this._extractInputFieldName(input, index);
    let fieldType = 'text';
    let currentValue = '';
    let options: string[] = [];

    if (input.tagName.toLowerCase() === 'select') {
      fieldType = 'select';
      const selectElement = input as HTMLSelectElement;
      currentValue = selectElement.value;
      
      Array.from(selectElement.options).forEach(option => {
        if (option.value) {
          options.push(option.value);
        }
      });
      
    } else if (input.tagName.toLowerCase() === 'textarea') {
      fieldType = 'textarea';
      currentValue = input.value;
      
    } else {
      const inputElement = input as HTMLInputElement;
      fieldType = inputElement.type || 'text';
      currentValue = inputElement.value;
    }

    // Find associated label
    const labelElement = document.querySelector(`label[for="${input.id}"]`) ||
                       input.closest('label') ||
                       input.parentElement?.querySelector('label');

    const label = labelElement?.textContent?.trim() || '';

    return {
      name: fieldName,
      type: fieldType,
      value: currentValue,
      label: label || undefined,
      placeholder: (input as HTMLInputElement).placeholder || undefined,
      required: input.required || false,
      disabled: input.disabled || false,
      options: options.length > 0 ? options : undefined,
      framework: 'React Final Form',
      inputType: 'standardInput',
    };
  }

  private _detectSpecializedReScriptComponents(): any[] {
    const fields: any[] = [];
    console.log('📋 Kriya: Detecting specialized ReScript components...');

    // 1. Detect Monaco Editor (Code Input)
    const monacoEditors = document.querySelectorAll('.monaco-editor, [data-monaco-editor]');
    monacoEditors.forEach((editor, index) => {
      const fieldName = editor.getAttribute('data-field-name') || `monaco-editor-${index}`;
      fields.push({
        name: fieldName,
        type: 'code',
        value: '', // Monaco editor value would need special extraction
        label: 'Code Editor',
        framework: 'Monaco Editor',
        inputType: 'monacoInput',
      });
    });

    // 2. Detect Draft.js Rich Text Editors
    const draftEditors = document.querySelectorAll('.DraftEditor-root, [data-draft-editor]');
    draftEditors.forEach((editor, index) => {
      const fieldName = editor.getAttribute('data-field-name') || `draft-editor-${index}`;
      fields.push({
        name: fieldName,
        type: 'richtext',
        value: '', // Draft.js content would need special extraction
        label: 'Rich Text Editor',
        framework: 'Draft.js',
        inputType: 'draftPreviewInput',
      });
    });

    // 3. Detect Async SelectBoxes (with loading states)
    const asyncSelects = document.querySelectorAll('[data-async-select], .async-selectbox');
    asyncSelects.forEach((select, index) => {
      const fieldName = select.getAttribute('data-field-name') || `async-select-${index}`;
      const button = select.querySelector('button');
      fields.push({
        name: fieldName,
        type: 'async-select',
        value: button?.getAttribute('data-value') || '',
        label: 'Async Select',
        placeholder: button?.textContent?.trim() || 'Loading...',
        framework: 'Async SelectBox',
        inputType: 'asyncSelectInput',
      });
    });

    // 4. Detect Nested Dropdowns
    const nestedDropdowns = document.querySelectorAll('[data-nested-dropdown]');
    nestedDropdowns.forEach((dropdown, index) => {
      const fieldName = dropdown.getAttribute('data-field-name') || `nested-dropdown-${index}`;
      fields.push({
        name: fieldName,
        type: 'nested-select',
        value: '', // Would need special extraction for nested values
        label: 'Nested Dropdown',
        framework: 'Nested Dropdown',
        inputType: 'nestedDropdown',
      });
    });

    // 5. Detect Calendar Inputs with highlighting
    const calendarInputs = document.querySelectorAll('[data-calendar-input], .calendar-highlighter');
    calendarInputs.forEach((calendar, index) => {
      const fieldName = calendar.getAttribute('data-field-name') || `calendar-${index}`;
      fields.push({
        name: fieldName,
        type: 'calendar',
        value: '', // Calendar selection would need special extraction
        label: 'Calendar Input',
        framework: 'Calendar Input',
        inputType: 'calendarInputHighlighted',
      });
    });

    // 6. Detect Time Range Inputs
    const timeRanges = document.querySelectorAll('[data-time-range]');
    timeRanges.forEach((timeRange, index) => {
      const fieldName = timeRange.getAttribute('data-field-name') || `time-range-${index}`;
      fields.push({
        name: fieldName,
        type: 'timerange',
        value: '', // Time range would need special extraction
        label: 'Time Range',
        framework: 'Time Range Input',
        inputType: 'timeRangeFields',
      });
    });

    console.log(`📋 Kriya: Found ${fields.length} specialized components`);
    return fields;
  }

  // Helper methods for better field name extraction
  private _extractFieldName(wrapper: HTMLElement, index: number): string {
    // 1. HIGHEST PRIORITY: Try to find input element and get its name/id (actual form field names)
    const inputElement = wrapper.querySelector('input, textarea, select, button[data-value]');
    if (inputElement) {
      const name = inputElement.getAttribute('name') || inputElement.id;
      if (name && name.trim()) {
        return this._stripFieldPrefix(name.trim());
      }
    }

    // 2. Try data-component-field-wrapper but strip any prefixes
    const fieldWrapper = wrapper.getAttribute('data-component-field-wrapper');
    if (fieldWrapper && fieldWrapper.trim()) {
      return this._stripFieldPrefix(fieldWrapper.trim());
    }

    // 3. Try to extract from label text
    const labelElement = wrapper.querySelector('[data-form-label]');
    const labelText = labelElement?.getAttribute('data-form-label') || 
                     labelElement?.textContent?.trim();
    if (labelText && labelText.trim()) {
      // Convert label text to camelCase field name
      return this._labelToFieldName(labelText.trim());
    }

    // 4. Try aria-label or other descriptive attributes
    const ariaLabel = wrapper.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) {
      return this._labelToFieldName(ariaLabel.trim());
    }

    // 5. Try to extract from placeholder text
    const placeholderElement = wrapper.querySelector('[placeholder]');
    const placeholder = placeholderElement?.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) {
      return this._labelToFieldName(placeholder.trim());
    }

    // 6. Try to extract from button text for SelectBox components
    const selectboxElement = wrapper.querySelector('[data-selectbox-value]');
    if (selectboxElement) {
      const selectboxTitle = selectboxElement.getAttribute('data-selectbox-value');
      if (selectboxTitle && selectboxTitle.trim()) {
        return this._labelToFieldName(selectboxTitle.trim());
      }
    }

    // 7. Last resort: use a descriptive fallback based on field type (no "field-" prefix)
    const fieldTypeHint = this._getFieldTypeHint(wrapper);
    return `${fieldTypeHint}_${index}`;
  }

  private _extractInputFieldName(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, index: number): string {
    // 1. Try name attribute first (highest priority for form inputs) - strip prefixes
    if (input.name && input.name.trim()) {
      return this._stripFieldPrefix(input.name.trim());
    }

    // 2. Try id attribute - strip prefixes
    if (input.id && input.id.trim()) {
      return this._stripFieldPrefix(input.id.trim());
    }

    // 3. Try to find associated label
    const labelElement = document.querySelector(`label[for="${input.id}"]`) ||
                        input.closest('label') ||
                        input.parentElement?.querySelector('label');
    
    const labelText = labelElement?.textContent?.trim();
    if (labelText) {
      return this._labelToFieldName(labelText);
    }

    // 4. Try placeholder as field name
    const placeholder = (input as HTMLInputElement).placeholder;
    if (placeholder && placeholder.trim()) {
      return this._labelToFieldName(placeholder.trim());
    }

    // 5. Try aria-label
    const ariaLabel = input.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) {
      return this._labelToFieldName(ariaLabel.trim());
    }

    // 6. Check if it's inside a field wrapper and extract from there - strip prefixes
    const fieldWrapper = input.closest('[data-component-field-wrapper]');
    if (fieldWrapper) {
      const wrapperName = fieldWrapper.getAttribute('data-component-field-wrapper');
      if (wrapperName && wrapperName.trim()) {
        return this._stripFieldPrefix(wrapperName.trim());
      }
    }

    // 7. Last resort: use input type + index (no "field-" prefix)
    const inputType = input.tagName.toLowerCase();
    const type = (input as HTMLInputElement).type || inputType;
    return `${type}_${index}`;
  }

  private _stripFieldPrefix(fieldName: string): string {
    // Remove common prefixes that are added by form frameworks
    const prefixesToRemove = ['field-', 'form-', 'input-', 'rff-field-', 'wrapper-field-'];
    
    for (const prefix of prefixesToRemove) {
      if (fieldName.startsWith(prefix)) {
        const stripped = fieldName.substring(prefix.length);
        // Only strip if there's still a meaningful name left
        if (stripped && stripped.length > 0) {
          return stripped;
        }
      }
    }
    
    return fieldName;
  }

  private _labelToFieldName(label: string): string {
    // Convert label text to a valid field name
    return label
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '') // Remove special characters
      .replace(/\s+/g, '_') // Replace spaces with underscores
      .replace(/^_+|_+$/g, '') // Remove leading/trailing underscores
      .replace(/_+/g, '_') // Replace multiple underscores with single
      || 'unknown_field';
  }

  private _getFieldTypeHint(wrapper: HTMLElement): string {
    // Try to determine field type from wrapper content to create better fallback names
    if (wrapper.querySelector('[data-selectbox-value]')) return 'selectbox';
    if (wrapper.querySelector('input[type="text"]')) return 'text';
    if (wrapper.querySelector('input[type="number"]')) return 'number';
    if (wrapper.querySelector('input[type="email"]')) return 'email';
    if (wrapper.querySelector('input[type="password"]')) return 'password';
    if (wrapper.querySelector('input[type="checkbox"]')) return 'checkbox';
    if (wrapper.querySelector('input[type="radio"]')) return 'radio';
    if (wrapper.querySelector('input[type="file"]')) return 'file';
    if (wrapper.querySelector('textarea')) return 'textarea';
    if (wrapper.querySelector('button[data-value]')) return 'button';
    if (wrapper.querySelector('input[type="date"]')) return 'date';
    if (wrapper.querySelector('input[type="range"]')) return 'range';
    
    return 'field';
  }

  private _isFieldNameSimilar(fieldName: string, existingFieldNames: string[]): boolean {
    // Check if a field name is similar to existing ones to avoid duplicates
    // This handles cases like "task_name" vs "field-task_name"
    
    const normalizedFieldName = this._normalizeFieldName(fieldName);
    
    return existingFieldNames.some(existingName => {
      const normalizedExistingName = this._normalizeFieldName(existingName);
      
      // Exact match after normalization
      if (normalizedFieldName === normalizedExistingName) {
        return true;
      }
      
      // Check if one contains the other (for cases like "task_name" and "field-task_name")
      if (normalizedFieldName.includes(normalizedExistingName) || 
          normalizedExistingName.includes(normalizedFieldName)) {
        // Only consider it similar if the longer name is just a prefixed/suffixed version
        const longer = normalizedFieldName.length > normalizedExistingName.length ? normalizedFieldName : normalizedExistingName;
        const shorter = normalizedFieldName.length > normalizedExistingName.length ? normalizedExistingName : normalizedFieldName;
        
        // Check if the longer name is just the shorter name with a common prefix/suffix
        const commonPrefixes = ['field', 'input', 'form', 'rff', 'wrapper'];
        const commonSuffixes = ['field', 'input', 'value'];
        
        for (const prefix of commonPrefixes) {
          if (longer === `${prefix}_${shorter}` || longer === `${prefix}-${shorter}`) {
            return true;
          }
        }
        
        for (const suffix of commonSuffixes) {
          if (longer === `${shorter}_${suffix}` || longer === `${shorter}-${suffix}`) {
            return true;
          }
        }
      }
      
      return false;
    });
  }

  private _normalizeFieldName(fieldName: string): string {
    // Normalize field name for comparison by removing common variations
    return fieldName
      .toLowerCase()
      .replace(/[-_\s]+/g, '_') // Normalize separators to underscores
      .replace(/^(field|input|form|rff|wrapper)_?/i, '') // Remove common prefixes
      .replace(/_(field|input|value)$/i, '') // Remove common suffixes
      .trim();
  }
}
