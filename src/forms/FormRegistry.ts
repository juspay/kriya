import type {
  AutomationConfig,
  EventCallback,
  EventType,
  FormAPI,
  FormContext,
  FormFieldContext,
  FormFieldValue,
  FormFillResult,
  FormLibrary,
  FormRegistryConfig,
} from '@/types';
import { DEFAULT_FORM_REGISTRY_CONFIG } from '@/types';
import { AutomationError } from '@/types';

export class FormRegistry {
  private readonly _config: AutomationConfig;
  private readonly _formConfig: FormRegistryConfig;
  private readonly _forms: Map<string, FormAPI>;
  private readonly _formElements: Map<string, HTMLFormElement>;
  private _formLibrary: FormLibrary | null;
  private _initialized: boolean;
  private _mutationObserver: MutationObserver | null;
  public addEventListener: ((eventType: EventType, callback: EventCallback) => void) | null;

  constructor(config: AutomationConfig) {
    this._config = config;
    this._formConfig = { ...DEFAULT_FORM_REGISTRY_CONFIG };
    this._forms = new Map();
    this._formElements = new Map();
    this._formLibrary = null;
    this._initialized = false;
    this._mutationObserver = null;
    this.addEventListener = null;
  }

  public initialize(formLibrary?: FormLibrary): void {
    if (this._initialized) {
      throw new AutomationError(
        'FormRegistry is already initialized',
        'INVALID_CONFIGURATION'
      );
    }

    this._formLibrary = formLibrary ?? null;
    this._initialized = true;

    if (this._formConfig.autoDetect) {
      this._detectAndRegisterForms();
    }

    if (this._formConfig.trackFormChanges && typeof MutationObserver !== 'undefined') {
      this._startDynamicFormDetection();
    }
  }

  public registerForm(formId: string, formElement: HTMLFormElement): void {
    this._ensureInitialized();

    if (this._forms.has(formId)) {
      throw new AutomationError(
        `Form with ID '${formId}' is already registered`,
        'FORM_NOT_FOUND',
        { formId }
      );
    }

    if (this._forms.size >= this._formConfig.maxForms) {
      throw new AutomationError(
        `Maximum number of forms (${this._formConfig.maxForms}) exceeded`,
        'INVALID_CONFIGURATION',
        { maxForms: this._formConfig.maxForms }
      );
    }

    let formApi: FormAPI | null = null;

    if (this._formLibrary && this._formLibrary.isCompatible(formElement)) {
      formApi = this._formLibrary.getFormAPI(formElement);
    }

    if (!formApi) {
      formApi = this._createNativeFormAPI(formElement);
    }

    this._forms.set(formId, formApi);
    this._formElements.set(formId, formElement);

    if (this.addEventListener) {
      this.addEventListener('form_registered', (() => {}) as EventCallback);
    }
  }

  public unregisterForm(formId: string): void {
    this._ensureInitialized();

    if (!this._forms.has(formId)) {
      throw new AutomationError(
        `Form with ID '${formId}' is not registered`,
        'FORM_NOT_FOUND',
        { formId }
      );
    }

    this._forms.delete(formId);
    this._formElements.delete(formId);

    if (this.addEventListener) {
      this.addEventListener('form_unregistered', (() => {}) as EventCallback);
    }
  }

  public async fillForm(formId: string, fields: Record<string, string>): Promise<FormFillResult> {
    this._ensureInitialized();

    const formApi = this._forms.get(formId);
    if (!formApi) {
      throw new AutomationError(
        `Form with ID '${formId}' is not registered`,
        'FORM_NOT_FOUND',
        { formId }
      );
    }

    return this._fillFormInternal(formApi, fields, formId);
  }

  public async fillAnyForm(fields: Record<string, string>): Promise<FormFillResult> {
    this._ensureInitialized();

    if (this._forms.size === 0) {
      throw new AutomationError(
        'No forms are registered',
        'FORM_NOT_FOUND'
      );
    }

    const bestMatch = this._findBestFormMatch(fields);
    if (!bestMatch) {
      throw new AutomationError(
        'No suitable form found for the provided fields',
        'FORM_NOT_FOUND',
        { fields: Object.keys(fields) }
      );
    }

    return this._fillFormInternal(bestMatch.formApi, fields, bestMatch.formId);
  }

  public async submitForm(formId: string): Promise<FormFillResult> {
    this._ensureInitialized();

    const formApi = this._forms.get(formId);
    if (!formApi) {
      throw new AutomationError(
        `Form with ID '${formId}' is not registered`,
        'FORM_NOT_FOUND',
        { formId }
      );
    }

    try {
      await formApi.submit();
      
      const result: FormFillResult = {
        success: true,
        fieldsCount: 0,
        filledFields: [],
        failedFields: [],
        formId,
      };

      if (this.addEventListener) {
        this.addEventListener('form_submitted', (() => {}) as EventCallback);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      if (this.addEventListener) {
        this.addEventListener('form_submitted', (() => {}) as EventCallback);
      }

      throw new AutomationError(
        `Form submission failed: ${errorMessage}`,
        'EXECUTION_FAILED',
        { formId, originalError: error }
      );
    }
  }

  public async submitAnyForm(): Promise<FormFillResult> {
    this._ensureInitialized();

    if (this._forms.size === 0) {
      throw new AutomationError(
        'No forms are registered',
        'FORM_NOT_FOUND'
      );
    }

    const firstFormEntry = this._forms.entries().next().value;
    if (!firstFormEntry) {
      throw new AutomationError(
        'No forms available for submission',
        'FORM_NOT_FOUND'
      );
    }

    const [formId, formApi] = firstFormEntry;
    return this.submitForm(formId);
  }

  public getFormContext(): readonly FormContext[] {
    this._ensureInitialized();

    const contexts: FormContext[] = [];

    for (const [formId, formElement] of this._formElements) {
      const fields = this._extractFormFields(formElement);
      const context: FormContext = {
        formId,
        action: formElement.action || undefined,
        method: formElement.method || 'GET',
        fields,
        isRegistered: true,
        hasSubmitButton: this._hasSubmitButton(formElement),
      };

      contexts.push(context);
    }

    return contexts;
  }

  public dispose(): void {
    if (this._mutationObserver) {
      this._mutationObserver.disconnect();
      this._mutationObserver = null;
    }
    this._forms.clear();
    this._formElements.clear();
    this._formLibrary = null;
    this._initialized = false;
    this.addEventListener = null;
  }

  private _ensureInitialized(): void {
    if (!this._initialized) {
      throw new AutomationError(
        'FormRegistry must be initialized before use',
        'INVALID_CONFIGURATION'
      );
    }
  }

  private _detectAndRegisterForms(): void {
    const forms = document.querySelectorAll('form');
    
    forms.forEach((form, index) => {
      const formId = form.id || form.name || `auto-detected-form-${index}`;
      
      try {
        this.registerForm(formId, form);
      } catch (error) {
        // Silently ignore registration errors during auto-detection
      }
    });
  }

  private _startDynamicFormDetection(): void {
    if (this._mutationObserver) {
      return; // Already started
    }

    this._mutationObserver = new MutationObserver((mutations) => {
      let shouldRedetect = false;

      mutations.forEach((mutation) => {
        // Check for added nodes that might be forms or contain forms
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as Element;
            
            // Check if the added node is a form
            if (element.tagName === 'FORM') {
              shouldRedetect = true;
            }
            
            // Check if the added node contains forms
            if (element.querySelector('form')) {
              shouldRedetect = true;
            }
            
            // Check for ReactFinalForm custom components
            if (this._isReactFinalFormField(element as HTMLElement) || 
                this._hasReactFinalFormFields(element)) {
              shouldRedetect = true;
            }
          }
        });

        // Check for removed nodes that might affect form registration
        mutation.removedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as Element;
            
            if (element.tagName === 'FORM') {
              // Try to unregister the form if it was registered
              const formId = (element as HTMLFormElement).id || 
                           (element as HTMLFormElement).name;
              if (formId && this._forms.has(formId)) {
                try {
                  this.unregisterForm(formId);
                } catch (error) {
                  // Silently ignore unregistration errors
                }
              }
            }
          }
        });

        // Check for attribute changes that might affect form field detection
        if (mutation.type === 'attributes') {
          const target = mutation.target as Element;
          const attributeName = mutation.attributeName;
          
          // Watch for changes that might affect field detection
          if (attributeName && [
            'data-field-name',
            'data-form-field',
            'role',
            'aria-expanded',
            'class',
            'name',
            'id'
          ].includes(attributeName)) {
            shouldRedetect = true;
          }
        }
      });

      // Debounce re-detection to avoid excessive processing
      if (shouldRedetect) {
        this._debouncedRedetection();
      }
    });

    // Start observing the document
    this._mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-field-name',
        'data-form-field',
        'role',
        'aria-expanded',
        'class',
        'name',
        'id'
      ]
    });
  }

  private _hasReactFinalFormFields(element: Element): boolean {
    const reactFinalFormSelectors = [
      '.select-box',
      '.dropdown',
      '[role="combobox"]',
      '[role="listbox"]',
      '[role="switch"]',
      '.toggle',
      '.switch',
      '[data-field-name]',
      '[data-form-field]',
      '.form-field',
      '.input-field',
      '.multi-select',
      '.chip-input',
      '.date-picker',
      '.date-input'
    ];

    return reactFinalFormSelectors.some(selector => 
      element.querySelector(selector) !== null
    );
  }

  private _debouncedRedetection = (() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      timeoutId = setTimeout(() => {
        try {
          this._detectAndRegisterForms();
        } catch (error) {
          // Silently ignore re-detection errors
        }
        timeoutId = null;
      }, 300); // 300ms debounce
    };
  })();

  private _createNativeFormAPI(formElement: HTMLFormElement): FormAPI {
    return {
      change: (field: string, value: unknown): void => {
        const element = formElement.querySelector(`[name="${field}"]`) as HTMLInputElement;
        if (element) {
          element.value = String(value);
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
      },

      submit: async (): Promise<void> => {
        return new Promise<void>((resolve, reject) => {
          const handleSubmit = (event: Event): void => {
            formElement.removeEventListener('submit', handleSubmit);
            
            if (event.defaultPrevented) {
              reject(new Error('Form submission was prevented'));
            } else {
              resolve();
            }
          };

          formElement.addEventListener('submit', handleSubmit);
          formElement.submit();
        });
      },

      getValues: (): Record<string, unknown> => {
        const formData = new FormData(formElement);
        const values: Record<string, unknown> = {};
        
        for (const [key, value] of formData.entries()) {
          values[key] = value;
        }
        
        return values;
      },

      getState: () => ({
        values: {},
        errors: {},
        touched: {},
        valid: formElement.checkValidity(),
        submitting: false,
        pristine: true,
      }),

      batch: (updates: () => void): void => {
        updates();
      },

      reset: (): void => {
        formElement.reset();
      },
    };
  }

  private async _fillFormInternal(
    formApi: FormAPI, 
    fields: Record<string, string>, 
    formId?: string
  ): Promise<FormFillResult> {
    const filledFields: string[] = [];
    const failedFields: string[] = [];

    try {
      formApi.batch(() => {
        for (const [fieldName, fieldValue] of Object.entries(fields)) {
          try {
            formApi.change(fieldName, fieldValue);
            filledFields.push(fieldName);
          } catch (error) {
            failedFields.push(fieldName);
          }
        }
      });

      const result: FormFillResult = {
        success: failedFields.length === 0,
        fieldsCount: Object.keys(fields).length,
        filledFields,
        failedFields,
        formId,
      };

      if (this.addEventListener) {
        this.addEventListener('form_filled', (() => {}) as EventCallback);
      }

      return result;
    } catch (error) {
      throw new AutomationError(
        `Form filling failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'EXECUTION_FAILED',
        { formId, fields: Object.keys(fields), originalError: error }
      );
    }
  }

  private _findBestFormMatch(fields: Record<string, string>): { formApi: FormAPI; formId: string } | null {
    const fieldNames = Object.keys(fields);
    let bestMatch: { formApi: FormAPI; formId: string; score: number } | null = null;

    for (const [formId, formElement] of this._formElements) {
      const formApi = this._forms.get(formId)!;
      const formFields = this._extractFormFields(formElement);
      
      let score = 0;
      for (const fieldName of fieldNames) {
        if (formFields.some(field => field.name === fieldName)) {
          score++;
        }
      }

      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { formApi, formId, score };
      }
    }

    return bestMatch || null;
  }

  private _extractFormFields(formElement: HTMLFormElement): readonly FormFieldContext[] {
    const fields: FormFieldContext[] = [];
    
    // Standard HTML form elements
    const standardElements = formElement.querySelectorAll('input, textarea, select');
    standardElements.forEach(element => {
      const htmlElement = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      
      if (!htmlElement.name && !this._formConfig.includeHiddenFields) {
        return;
      }

      if (htmlElement.type === 'hidden' && !this._formConfig.includeHiddenFields) {
        return;
      }

      const field: FormFieldContext = {
        name: htmlElement.name || htmlElement.id || '',
        type: htmlElement.type || htmlElement.tagName.toLowerCase(),
        value: htmlElement.value || '',
        placeholder: (htmlElement as HTMLInputElement).placeholder || undefined,
        required: htmlElement.required,
        disabled: htmlElement.disabled,
        label: this._getFieldLabel(htmlElement),
      };

      fields.push(field);
    });

    // ReactFinalForm and custom component detection
    const customFields = this._extractReactFinalFormFields(formElement);
    fields.push(...customFields);

    return fields;
  }

  private _extractReactFinalFormFields(formElement: HTMLFormElement): FormFieldContext[] {
    const fields: FormFieldContext[] = [];
    
    // Detect ReactFinalForm fields by looking for specific patterns
    const reactFinalFormSelectors = [
      // Dropdown/Select components
      '[data-testid*="dropdown"]',
      '[data-testid*="select"]',
      '.select-box',
      '.dropdown',
      '[role="combobox"]',
      '[role="listbox"]',
      
      // Boolean/Toggle components
      '[role="switch"]',
      '[role="checkbox"]',
      '.toggle',
      '.switch',
      
      // Custom input components
      '[data-field-name]',
      '[data-form-field]',
      
      // ReScript specific patterns
      '.form-field',
      '.input-field',
      
      // Multi-select components
      '.multi-select',
      '.chip-input',
      
      // Date picker components
      '.date-picker',
      '.date-input',
      
      // Design System Support - Universal patterns
      '[data-design-system="true"]',
      '[data-component-field-wrapper*="field"]',
      
      // ReScript Dashboard SelectBox Patterns (from actual component analysis)
      '[data-selectbox-value]',         // Main SelectBox containers
      '[data-dropdown-for]',            // SelectBox dropdown triggers
      '[data-dropdown]',                // Generic dropdown markers
      '[data-dropdown-value]',          // Individual dropdown options
      '[data-dropdown-numeric]',        // Dropdown option indexing
      
      // Form wrapper patterns
      '[data-component-field-wrapper]', // Field wrapper containers
      
      // Specialized dropdown patterns
      '[data-daterange-dropdown-value]', // Date range dropdowns
      '[data-gateway-dropdown]',         // Gateway selection dropdowns
      
      // Button and interaction patterns
      '[data-value]',                   // Button field values
      '[data-button-status]',           // Button state indicators
      '[data-custom-value]',            // Custom value fields
      
      // Additional form element patterns
      '[data-field-type]',              // Field type indicators
      '[data-form-label]',              // Form labels
    ];

    reactFinalFormSelectors.forEach(selector => {
      const elements = formElement.querySelectorAll(selector);
      elements.forEach(element => {
        const field = this._extractCustomFieldInfo(element as HTMLElement);
        if (field && !fields.some(f => f.name === field.name)) {
          fields.push(field);
        }
      });
    });

    // Look for ReactFinalForm field patterns in data attributes
    const allElements = formElement.querySelectorAll('*');
    allElements.forEach(element => {
      const htmlElement = element as HTMLElement;
      
      // Check for ReactFinalForm field indicators
      if (this._isReactFinalFormField(htmlElement)) {
        const field = this._extractCustomFieldInfo(htmlElement);
        if (field && !fields.some(f => f.name === field.name)) {
          fields.push(field);
        }
      }
    });

    return fields;
  }

  private _isReactFinalFormField(element: HTMLElement): boolean {
    // Check for ReactFinalForm field indicators
    const indicators = [
      element.hasAttribute('data-field-name'),
      element.hasAttribute('data-form-field'),
      element.classList.contains('form-field'),
      element.classList.contains('input-field'),
      element.getAttribute('role') === 'combobox',
      element.getAttribute('role') === 'listbox',
      element.getAttribute('role') === 'switch',
      element.querySelector('input, select, textarea') !== null,
      // Check for nested form controls
      element.querySelector('[name]') !== null,
    ];

    return indicators.some(indicator => indicator);
  }

  private _extractCustomFieldInfo(element: HTMLElement): FormFieldContext | null {
    // Try to extract field information from custom components
    const name = this._getFieldName(element);
    if (!name) return null;

    const type = this._getFieldType(element);
    const value = this._getFieldValue(element);
    const label = this._getFieldLabel(element);
    const placeholder = this._getFieldPlaceholder(element);
    const required = this._isFieldRequired(element);
    const disabled = this._isFieldDisabled(element);
    const options = this._getFieldOptions(element);
    const multiselect = type === 'multiselect';

    return {
      name,
      type,
      value,
      placeholder,
      required,
      disabled,
      label,
      options,
      multiselect,
    };
  }

  private _getFieldName(element: HTMLElement): string {
    // Try multiple ways to get field name
    const methods = [
      () => element.getAttribute('data-field-name'),
      () => element.getAttribute('data-form-field'),
      () => {
        // Design System: Extract from wrapper attribute (HIGH priority for field name)
        const wrapper = element.getAttribute('data-component-field-wrapper');
        if (wrapper && wrapper.startsWith('field-')) {
          return wrapper.replace('field-', '');
        }
        return null;
      },
      () => element.getAttribute('data-value'),           // Design System support
      () => element.getAttribute('name'),
      () => element.id,
      () => {
        const nestedInput = element.querySelector('[name]') as HTMLInputElement;
        return nestedInput?.name;
      },
      () => {
        const nestedInput = element.querySelector('input, select, textarea') as HTMLInputElement;
        return nestedInput?.name || nestedInput?.id;
      },
      () => {
        // Design System: Check for data-value in nested button (LOWER priority - this is value, not name)
        const nestedButton = element.querySelector('button[data-value]') as HTMLButtonElement;
        return nestedButton?.getAttribute('data-value');
      },
    ];

    for (const method of methods) {
      const result = method();
      if (result) return result;
    }

    return '';
  }

  private _getFieldType(element: HTMLElement): string {
    // Determine field type based on element characteristics
    const classList = element.classList;
    const role = element.getAttribute('role');
    const ariaExpanded = element.getAttribute('aria-expanded');
    
    // Design System Support - Check for specific data attributes first
    if (element.hasAttribute('data-selectbox-value') || element.hasAttribute('data-dropdown-for')) {
      return 'select';
    }
    if (element.hasAttribute('data-multiselect-value')) {
      return 'multiselect';
    }
    if (element.hasAttribute('data-toggle-value')) {
      return 'boolean';
    }
    if (element.hasAttribute('data-checkbox-value')) {
      return 'checkbox';
    }
    if (element.hasAttribute('data-radio-value')) {
      return 'radio';
    }
    if (element.hasAttribute('data-textarea-value')) {
      return 'textarea';
    }
    if (element.hasAttribute('data-datepicker-value')) {
      return 'date';
    }
    if (element.hasAttribute('data-search-value')) {
      return 'search';
    }
    if (element.hasAttribute('data-file-upload-value')) {
      return 'file';
    }
    if (element.hasAttribute('data-input-value')) {
      // Try to determine specific input type from context
      const inputType = element.getAttribute('data-field-type');
      if (inputType) {
        return inputType;
      }
      return 'text';
    }
    
    // Boolean/Toggle fields
    if (role === 'switch' || classList.contains('toggle') || classList.contains('switch')) {
      return 'boolean';
    }
    
    // Dropdown/Select fields
    if (role === 'combobox' || role === 'listbox' || 
        classList.contains('dropdown') || classList.contains('select-box') ||
        ariaExpanded !== null) {
      return 'select';
    }
    
    // Multi-select fields
    if (classList.contains('multi-select') || classList.contains('chip-input')) {
      return 'multiselect';
    }
    
    // Date fields
    if (classList.contains('date-picker') || classList.contains('date-input')) {
      return 'date';
    }
    
    // File upload fields
    if (classList.contains('file-upload') || element.querySelector('input[type="file"]')) {
      return 'file';
    }
    
    // Check nested input type
    const nestedInput = element.querySelector('input, select, textarea') as HTMLInputElement;
    if (nestedInput) {
      return nestedInput.type || nestedInput.tagName.toLowerCase();
    }
    
    // Default to text if can't determine
    return 'text';
  }

  private _getFieldValue(element: HTMLElement): string {
    // Try to get field value from various sources
    const methods = [
      () => {
        // Design System: For selectbox fields, get button text content (the selected value)
        if (element.hasAttribute('data-selectbox-value') || element.hasAttribute('data-dropdown-for')) {
          const button = element.querySelector('button[data-value]');
          const buttonTextDiv = button?.querySelector('[data-button-text]');
          if (buttonTextDiv) {
            return buttonTextDiv.textContent?.trim();
          }
          // Fallback to button text content
          return button?.textContent?.trim();
        }
        return null;
      },
      () => element.getAttribute('value'),
      () => {
        const nestedInput = element.querySelector('input, select, textarea') as HTMLInputElement;
        return nestedInput?.value;
      },
      () => {
        // For dropdowns, get selected option text
        const selectedOption = element.querySelector('[aria-selected="true"]');
        return selectedOption?.textContent?.trim();
      },
      () => {
        // For boolean fields, check if active/checked
        const isActive = element.classList.contains('active') || 
                        element.classList.contains('checked') ||
                        element.getAttribute('aria-checked') === 'true';
        return isActive ? 'true' : 'false';
      },
      () => element.getAttribute('data-value'),  // Lower priority - this is often the field key, not value
      () => element.textContent?.trim(),
    ];

    for (const method of methods) {
      const result = method();
      if (result) return result;
    }

    return '';
  }

  private _getFieldPlaceholder(element: HTMLElement): string | undefined {
    const methods = [
      () => element.getAttribute('placeholder'),
      () => element.getAttribute('data-placeholder'),
      () => {
        const nestedInput = element.querySelector('input, textarea') as HTMLInputElement;
        return nestedInput?.placeholder;
      },
      () => {
        // For dropdowns, get button text that might act as placeholder
        const button = element.querySelector('button');
        const buttonText = button?.textContent?.trim();
        if (buttonText && (buttonText.includes('Select') || buttonText.includes('Choose'))) {
          return buttonText;
        }
        return undefined;
      },
    ];

    for (const method of methods) {
      const result = method();
      if (result) return result;
    }

    return undefined;
  }

  private _isFieldRequired(element: HTMLElement): boolean {
    const indicators = [
      element.hasAttribute('required'),
      element.getAttribute('aria-required') === 'true',
      element.classList.contains('required'),
      element.querySelector('[required]') !== null,
      element.querySelector('*')?.textContent?.includes('*') || false,
    ];

    return indicators.some(indicator => indicator);
  }

  private _isFieldDisabled(element: HTMLElement): boolean {
    const indicators = [
      element.hasAttribute('disabled'),
      element.getAttribute('aria-disabled') === 'true',
      element.classList.contains('disabled'),
      element.querySelector('[disabled]') !== null,
    ];

    return indicators.some(indicator => indicator);
  }

  private _getFieldOptions(element: HTMLElement): readonly string[] | undefined {
    const options: string[] = [];
    
    // Try different methods to extract options based on component type
    const methods = [
      () => {
        // Standard select element options
        const selectElement = element.querySelector('select') as HTMLSelectElement;
        if (selectElement) {
          return Array.from(selectElement.options).map(option => option.text || option.value);
        }
        return null;
      },
      () => {
        // Options in dropdown lists (ul/li structure)
        const optionsList = element.querySelectorAll('[role="option"], li[data-value], .option');
        if (optionsList.length > 0) {
          return Array.from(optionsList).map(option => 
            option.textContent?.trim() || option.getAttribute('data-value') || ''
          ).filter(text => text.length > 0);
        }
        return null;
      },
      () => {
        // Options in ReScript dropdown components
        const dropdownOptions = element.querySelectorAll('.dropdown-option, .select-option, [data-option]');
        if (dropdownOptions.length > 0) {
          return Array.from(dropdownOptions).map(option => 
            option.textContent?.trim() || option.getAttribute('data-option') || ''
          ).filter(text => text.length > 0);
        }
        return null;
      },
      () => {
        // Check for chip/tag options in multi-select
        const chips = element.querySelectorAll('.chip, .tag, .selected-option');
        if (chips.length > 0) {
          return Array.from(chips).map(chip => 
            chip.textContent?.trim() || ''
          ).filter(text => text.length > 0);
        }
        return null;
      },
      () => {
        // Check for data attributes containing options
        const optionsData = element.getAttribute('data-options');
        if (optionsData) {
          try {
            const parsed = JSON.parse(optionsData);
            if (Array.isArray(parsed)) {
              return parsed.map(opt => typeof opt === 'string' ? opt : opt.label || opt.value || String(opt));
            }
          } catch (e) {
            // If not JSON, try comma-separated values
            return optionsData.split(',').map(opt => opt.trim()).filter(opt => opt.length > 0);
          }
        }
        return null;
      },
    ];

    for (const method of methods) {
      const result = method();
      if (result && result.length > 0) {
        return result;
      }
    }

    // If no options found but it's a select/dropdown type, return undefined
    // This indicates it's a select field but options couldn't be determined
    const type = this._getFieldType(element);
    if (type === 'select' || type === 'multiselect') {
      return undefined;
    }

    // For non-select fields, don't return options
    return undefined;
  }

  private _getFieldLabel(element: HTMLElement): string | undefined {
    const id = element.id;
    if (id) {
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) {
        return label.textContent?.trim() || undefined;
      }
    }

    const parentLabel = element.closest('label');
    if (parentLabel) {
      return parentLabel.textContent?.trim() || undefined;
    }

    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) {
      return ariaLabel.trim();
    }

    return undefined;
  }

  private _hasSubmitButton(formElement: HTMLFormElement): boolean {
    const submitButtons = formElement.querySelectorAll(
      'input[type="submit"], button[type="submit"], button:not([type])'
    );
    return submitButtons.length > 0;
  }
}
