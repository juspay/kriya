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
import { EnhancedFormDetector } from './EnhancedFormDetector';

export class FormRegistry {
  private readonly _config: AutomationConfig;
  private readonly _formConfig: FormRegistryConfig;
  private readonly _forms: Map<string, FormAPI>;
  private readonly _formElements: Map<string, HTMLFormElement>;
  private _formLibrary: FormLibrary | null;
  private _initialized: boolean;
  public addEventListener: ((eventType: EventType, callback: EventCallback) => void) | null;

  constructor(config: AutomationConfig) {
    this._config = config;
    this._formConfig = { ...DEFAULT_FORM_REGISTRY_CONFIG };
    this._forms = new Map();
    this._formElements = new Map();
    this._formLibrary = null;
    this._initialized = false;
    this.addEventListener = null;
  }

  // Force logs to appear even if console.log is filtered
  private _forceLog(...args: any[]): void {
    console.log('🔍 KRIYA:', ...args);
    console.info('🔍 KRIYA:', ...args);
    console.warn('🔍 KRIYA:', ...args);
    // Also try direct console access
    (window as any).console?.log?.('🔍 KRIYA:', ...args);
  }

  public initialize(formLibrary?: FormLibrary): void {
    if (this._initialized) {
      throw new AutomationError('FormRegistry is already initialized', 'INVALID_CONFIGURATION');
    }

    this._formLibrary = formLibrary ?? null;
    this._initialized = true;

    if (this._formConfig.autoDetect) {
      this._detectAndRegisterForms();
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
      throw new AutomationError(`Form with ID '${formId}' is not registered`, 'FORM_NOT_FOUND', {
        formId,
      });
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
      throw new AutomationError(`Form with ID '${formId}' is not registered`, 'FORM_NOT_FOUND', {
        formId,
      });
    }

    return this._fillFormInternal(formApi, fields, formId);
  }

  public async fillAnyForm(fields: Record<string, string>): Promise<FormFillResult> {
    this._ensureInitialized();

    this._forceLog(`🔍 Starting fillAnyForm with fields:`, Object.keys(fields));
    this._forceLog(`📊 Currently registered forms: ${this._forms.size}`);

    // 🚀 PRIORITY 1: Try Enhanced Form Detector FIRST
    this._forceLog('🚀 PRIORITY 1: Trying Enhanced Form Detector first...');
    const enhancedResult = this._tryEnhancedFormDetector(fields);
    if (enhancedResult) {
      this._forceLog('✅ Enhanced Form Detector succeeded on first try!');
      return enhancedResult;
    }

    // If no forms are registered, try to detect them again
    if (this._forms.size === 0) {
      this._forceLog('🔄 No forms registered, attempting to detect forms...');
      this._detectAndRegisterForms();
      this._forceLog(`📊 After detection: ${this._forms.size} forms registered`);
    }

    // Still no forms found
    if (this._forms.size === 0) {
      this._forceLog('❌ No forms detected on the page');
      this._logPageFormInfo(); // Debug: show what forms exist on page
      throw new AutomationError('No forms are registered', 'FORM_NOT_FOUND');
    }

    // Log current form details for debugging
    this._logRegisteredFormDetails();

    // PRIORITY 2: Try traditional form matching
    this._forceLog('🔄 PRIORITY 2: Trying traditional form matching...');
    const bestMatch = this._findBestFormMatch(fields);
    if (bestMatch) {
      this._forceLog(`✅ Found best match: ${bestMatch.formId} (score: ${(bestMatch as any).score})`);
      return this._fillFormInternal(bestMatch.formApi, fields, bestMatch.formId);
    }

    // PRIORITY 3: Try alternative matching strategies
    this._forceLog('🔄 PRIORITY 3: Trying alternative field matching strategies...');
    const alternativeMatch = this._findAlternativeFormMatch(fields);
    if (alternativeMatch) {
      this._forceLog('✅ Found form using alternative matching');
      return this._fillFormInternal(alternativeMatch.formApi, fields, alternativeMatch.formId);
    }

    // Log detailed field mismatch info
    this._logFieldMismatchDetails(fields);

    throw new AutomationError(
      'No suitable form found for the provided fields',
      'FORM_NOT_FOUND',
      {
        fields: Object.keys(fields),
        availableForms: this._getFormSummary(),
      }
    );
  }

  public async submitForm(formId: string): Promise<FormFillResult> {
    this._ensureInitialized();

    const formApi = this._forms.get(formId);
    if (!formApi) {
      throw new AutomationError(`Form with ID '${formId}' is not registered`, 'FORM_NOT_FOUND', {
        formId,
      });
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

      throw new AutomationError(`Form submission failed: ${errorMessage}`, 'EXECUTION_FAILED', {
        formId,
        originalError: error,
      });
    }
  }

  public async submitAnyForm(): Promise<FormFillResult> {
    this._ensureInitialized();

    if (this._forms.size === 0) {
      throw new AutomationError('No forms are registered', 'FORM_NOT_FOUND');
    }

    const firstFormEntry = this._forms.entries().next().value;
    if (!firstFormEntry) {
      throw new AutomationError('No forms available for submission', 'FORM_NOT_FOUND');
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
    this._forceLog('🔍 Starting form detection...');
    const forms = document.querySelectorAll('form');
    this._forceLog(`📋 Found ${forms.length} <form> elements on page`);

    let successCount = 0;
    let failCount = 0;

    forms.forEach((form, index) => {
      const formId = form.id || form.name || `auto-detected-form-${index}`;
      this._forceLog(`🔄 Attempting to register form: ${formId}`);

      try {
        this.registerForm(formId, form);
        successCount++;
        this._forceLog(`✅ Successfully registered form: ${formId}`);
      } catch (error) {
        failCount++;
        this._forceLog(`❌ Failed to register form ${formId}:`, error);

        // Try with a unique ID to avoid duplicates
        const uniqueFormId = `${formId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        try {
          this._forceLog(`🔄 Retrying with unique ID: ${uniqueFormId}`);
          this.registerForm(uniqueFormId, form);
          successCount++;
          this._forceLog(`✅ Successfully registered form with unique ID: ${uniqueFormId}`);
        } catch (retryError) {
          this._forceLog(`❌ Final attempt failed for form ${uniqueFormId}:`, retryError);
        }
      }
    });

    this._forceLog(`📊 Form detection complete: ${successCount} registered, ${failCount} failed`);
    this._forceLog(`📊 Total forms now registered: ${this._forms.size}`);
  }

  private _createNativeFormAPI(formElement: HTMLFormElement): FormAPI {
    // First try to extract React Final Form API
    const reactFormAPI = this._extractReactFinalFormAPI(formElement);
    if (reactFormAPI) {
      this._forceLog('✅ Found React Final Form API, using enhanced API');
      return this._createEnhancedFormAPI(reactFormAPI, formElement);
    }

    this._forceLog('🔄 No React Final Form detected, creating native wrapper API');
    return this._createNativeWrapperAPI(formElement);
  }

  private _extractReactFinalFormAPI(formElement: HTMLFormElement): any {
    try {
      // Look for React fiber node on the form element
      const reactKey = Object.keys(formElement).find(
        key => key.startsWith('__reactInternalInstance') || key.startsWith('__reactFiber')
      );

      if (!reactKey) {
        this._forceLog('🔍 No React fiber found on form element');
        return null;
      }

      let fiber = (formElement as any)[reactKey];
      let attempts = 0;
      const maxAttempts = 20;

      this._forceLog('🔍 Walking React fiber tree to find Form component...');

      // Walk up the React fiber tree to find Form component
      while (fiber && attempts < maxAttempts) {
        attempts++;

        // Check if this fiber has form-related props or state
        if (fiber.memoizedProps?.onSubmit) {
          this._forceLog(`🎯 Found component with onSubmit at attempt ${attempts}`);

          // Look for React Final Form API in various locations
          const formAPI = this._extractFormAPIFromFiber(fiber);
          if (formAPI) {
            this._forceLog('✅ Successfully extracted React Final Form API');
            return formAPI;
          }
        }

        // Check for React Final Form context
        if (fiber.type?.displayName === 'Form' || fiber.type?.name === 'Form') {
          this._forceLog(`🎯 Found Form component: ${fiber.type.displayName || fiber.type.name}`);
          const formAPI = this._extractFormAPIFromFiber(fiber);
          if (formAPI) {
            this._forceLog('✅ Successfully extracted React Final Form API from Form component');
            return formAPI;
          }
        }

        fiber = fiber.return;
      }

      this._forceLog(
        `🔍 Reached max attempts (${maxAttempts}) without finding React Final Form API`
      );
      return null;
    } catch (error) {
      this._forceLog('❌ Error during React Final Form extraction:', error);
      return null;
    }
  }

  private _extractFormAPIFromFiber(fiber: any): any {
    try {
      // Strategy 1: Direct state node access
      if (fiber.stateNode?.form) {
        this._forceLog('📍 Found formAPI in fiber.stateNode.form');
        return fiber.stateNode.form;
      }

      // Strategy 2: Child component props
      if (fiber.child?.memoizedProps?.form) {
        this._forceLog('📍 Found formAPI in fiber.child.memoizedProps.form');
        return fiber.child.memoizedProps.form;
      }

      // Strategy 3: Check memoizedProps directly
      if (fiber.memoizedProps?.form) {
        this._forceLog('📍 Found formAPI in fiber.memoizedProps.form');
        return fiber.memoizedProps.form;
      }

      // Strategy 4: Look in React context
      if (fiber.dependencies?.firstContext) {
        this._forceLog('🔍 Checking React context for form API...');
        let context = fiber.dependencies.firstContext;
        while (context) {
          if (context.memoizedValue?.form) {
            this._forceLog('📍 Found formAPI in React context');
            return context.memoizedValue.form;
          }
          context = context.next;
        }
      }

      // Strategy 5: Check hooks for useForm
      if (fiber.memoizedState) {
        this._forceLog('🔍 Checking hooks state for form API...');
        let hook = fiber.memoizedState;
        while (hook) {
          if (hook.memoizedState && typeof hook.memoizedState === 'object') {
            // Check if this looks like a form API
            if (
              hook.memoizedState.change &&
              hook.memoizedState.submit &&
              hook.memoizedState.batch
            ) {
              this._forceLog('📍 Found formAPI in hooks state');
              return hook.memoizedState;
            }
          }
          hook = hook.next;
        }
      }

      return null;
    } catch (error) {
      this._forceLog('❌ Error extracting form API from fiber:', error);
      return null;
    }
  }

  private _createEnhancedFormAPI(reactFormAPI: any, formElement: HTMLFormElement): FormAPI {
    // Create enhanced API that uses React Final Form methods
    return {
      // Use React Final Form's initialize method for setting initial values
      initialize: (values: Record<string, unknown>): void => {
        this._forceLog('🚀 Initializing form with values:', Object.keys(values));
        if (reactFormAPI.initialize) {
          reactFormAPI.initialize(values);
        } else {
          this._forceLog('⚠️ Form API missing initialize method, falling back to batch change');
          this._batchFillFields(reactFormAPI, values);
        }
      },

      change: (field: string, value: unknown): void => {
        this._forceLog(`🔄 Changing field "${field}" to:`, value);
        if (reactFormAPI.change) {
          reactFormAPI.change(field, value);
        } else {
          this._forceLog('⚠️ Form API missing change method, using DOM fallback');
          this._fillFieldDirectly(formElement, field, value);
        }
      },

      submit: async (): Promise<void> => {
        this._forceLog('📤 Submitting form via React Final Form API');
        if (reactFormAPI.submit) {
          return reactFormAPI.submit();
        } else {
          this._forceLog('⚠️ Form API missing submit method, using DOM fallback');
          return this._submitFormDirectly(formElement);
        }
      },

      getValues: (): Record<string, unknown> => {
        if (reactFormAPI.getState) {
          const state = reactFormAPI.getState();
          return state.values || {};
        }
        return this._extractFormData(formElement);
      },

      getState: () => {
        if (reactFormAPI.getState) {
          return reactFormAPI.getState();
        }
        return {
          values: this._extractFormData(formElement),
          errors: {},
          touched: {},
          valid: formElement.checkValidity(),
          submitting: false,
          pristine: true,
        };
      },

      batch: (updates: () => void): void => {
        this._forceLog('📦 Executing batch updates');
        if (reactFormAPI.batch) {
          reactFormAPI.batch(updates);
        } else {
          this._forceLog('⚠️ Form API missing batch method, executing updates directly');
          updates();
        }
      },

      reset: (): void => {
        this._forceLog('🔄 Resetting form');
        if (reactFormAPI.reset) {
          reactFormAPI.reset();
        } else {
          formElement.reset();
        }
      },
    };
  }

  private _createNativeWrapperAPI(formElement: HTMLFormElement): FormAPI {
    return {
      change: (field: string, value: unknown): void => {
        this._fillFieldDirectly(formElement, field, value);
      },

      submit: async (): Promise<void> => {
        return this._submitFormDirectly(formElement);
      },

      getValues: (): Record<string, unknown> => {
        return this._extractFormData(formElement);
      },

      getState: () => ({
        values: this._extractFormData(formElement),
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
      this._forceLog(
        `🚀 Filling form ${formId || 'any'} with ${Object.keys(fields).length} fields`
      );
      this._forceLog(
        `📋 Field details:`,
        Object.entries(fields).map(([name, value]) => `${name}: "${value}" (${value.length} chars)`)
      );

      // Filter out invalid field names and empty values
      const validFields = this._filterValidFields(fields);
      this._forceLog(
        `✅ Valid fields after filtering: ${Object.keys(validFields).length}/${Object.keys(fields).length}`
      );

      if (Object.keys(validFields).length === 0) {
        this._forceLog('❌ No valid fields to fill after filtering');
        return {
          success: false,
          fieldsCount: Object.keys(fields).length,
          filledFields: [],
          failedFields: Object.keys(fields),
          formId,
        };
      }

      // Check if this is a React Final Form with initialize method
      if (formApi.initialize && typeof formApi.initialize === 'function') {
        this._forceLog('✨ Using React Final Form initialize() for efficient bulk filling');

        try {
          // Use initialize for bulk setting of values (more efficient for React Final Form)
          formApi.initialize(validFields);

          // Mark all valid fields as successfully filled
          filledFields.push(...Object.keys(validFields));

          // Mark invalid fields as failed
          const invalidFields = Object.keys(fields).filter(key => !validFields.hasOwnProperty(key));
          failedFields.push(...invalidFields);

          this._forceLog(
            `✅ Successfully initialized ${filledFields.length} fields via initialize()`
          );
          if (invalidFields.length > 0) {
            this._forceLog(`⚠️ Skipped invalid fields: ${invalidFields.join(', ')}`);
          }
        } catch (error) {
          this._forceLog('⚠️ Initialize method failed, falling back to individual field changes');
          this._forceLog('❌ Initialize error:', error);

          // Fallback to individual field changes if initialize fails
          await this._fillFieldsIndividually(formApi, validFields, filledFields, failedFields);
        }
      } else {
        this._forceLog('🔄 Using individual field changes (no initialize method available)');

        // For native forms or React Final Form without initialize, use individual changes
        await this._fillFieldsIndividually(formApi, validFields, filledFields, failedFields);
      }

      const result: FormFillResult = {
        success: failedFields.length === 0,
        fieldsCount: Object.keys(fields).length,
        filledFields,
        failedFields,
        formId,
      };

      this._forceLog(
        `📊 Form fill result: ${filledFields.length}/${Object.keys(fields).length} fields filled successfully`
      );

      if (failedFields.length > 0) {
        this._forceLog(`⚠️ Failed fields: ${failedFields.join(', ')}`);
      }

      if (this.addEventListener) {
        this.addEventListener('form_filled', (() => {}) as EventCallback);
      }

      return result;
    } catch (error) {
      this._forceLog('❌ Form filling operation failed:', error);
      throw new AutomationError(
        `Form filling failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'EXECUTION_FAILED',
        { formId, fields: Object.keys(fields), originalError: error }
      );
    }
  }

  private _findBestFormMatch(
    fields: Record<string, string>
  ): { formApi: FormAPI; formId: string } | null {
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
    const elements = formElement.querySelectorAll('input, textarea, select');

    elements.forEach(element => {
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

    return fields;
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

  private _findFormField(formElement: HTMLFormElement, fieldName: string): HTMLElement | null {
    this._forceLog(`🔍 FormRegistry: Looking for field "${fieldName}"`);

    // Strategy 1: Find by exact name attribute
    let element = formElement.querySelector(`[name="${fieldName}"]`) as HTMLElement;
    if (element) {
      this._forceLog(`✅ Found field "${fieldName}" by name attribute`);
      return element;
    }

    // Strategy 2: Find by data-component-field-wrapper (exact match)
    element = formElement.querySelector(
      `[data-component-field-wrapper="${fieldName}"]`
    ) as HTMLElement;
    if (element) {
      this._forceLog(`✅ Found field "${fieldName}" by exact wrapper match`);
      return element;
    }

    // Strategy 3: Find by data-component-field-wrapper with "field-" prefix
    const fieldWithPrefix = `field-${fieldName}`;
    element = formElement.querySelector(
      `[data-component-field-wrapper="${fieldWithPrefix}"]`
    ) as HTMLElement;
    if (element) {
      this._forceLog(`✅ Found field "${fieldName}" by wrapper with prefix: "${fieldWithPrefix}"`);
      return element;
    }

    // Strategy 4: Search globally for field wrappers (exact and with prefix)
    const allWrappers = document.querySelectorAll('[data-component-field-wrapper]');
    for (const wrapper of allWrappers) {
      const wrapperName = wrapper.getAttribute('data-component-field-wrapper');
      if (wrapperName === fieldName || wrapperName === fieldWithPrefix) {
        this._forceLog(`✅ Found field "${fieldName}" globally by wrapper: "${wrapperName}"`);
        element = wrapper.querySelector(
          'input, textarea, select, button[data-value]'
        ) as HTMLElement;
        if (element) return element;
        return wrapper as HTMLElement;
      }
    }

    // Strategy 5: Find by field ID
    element = formElement.querySelector(`#${fieldName}`) as HTMLElement;
    if (element) {
      this._forceLog(`✅ Found field "${fieldName}" by ID`);
      return element;
    }

    // Strategy 6: Global search by name (in case field is outside detected form)
    element = document.querySelector(`[name="${fieldName}"]`) as HTMLElement;
    if (element) {
      this._forceLog(`✅ Found field "${fieldName}" globally by name`);
      return element;
    }

    this._forceLog(`❌ Field "${fieldName}" not found`);
    return null;
  }

  private _fillElementAdvanced(element: HTMLElement, value: string): void {
    // Detect if this is a ReScript SelectBox component
    const isSelectBox =
      this._detectSelectBoxComponent(element) || element.closest('[data-selectbox-value]') !== null;

    if (isSelectBox) {
      this._fillReScriptSelectBox(element, value);
      return;
    }

    // Handle standard HTML elements
    const tagName = element.tagName.toLowerCase();
    if (tagName === 'input' || tagName === 'textarea') {
      (element as HTMLInputElement).value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (tagName === 'select') {
      const selectElement = element as HTMLSelectElement;
      const option = Array.from(selectElement.options).find(
        opt => opt.value === value || opt.textContent === value
      );

      if (option) {
        selectElement.selectedIndex = option.index;
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  private _detectSelectBoxComponent(element: HTMLElement): boolean {
    // Check for Euler dashboard SelectBox data attributes
    if (element.hasAttribute('data-selectbox-value')) return true;
    if (element.closest('[data-selectbox-value]')) return true;

    // Check if element is a button within a SelectBox
    if (element.tagName.toLowerCase() === 'button') {
      if (element.hasAttribute('data-value') && element.querySelector('[data-button-text]'))
        return true;
      if (element.hasAttribute('data-value') && element.closest('[data-selectbox-value]'))
        return true;
    }

    return false;
  }

  private _fillReScriptSelectBox(element: HTMLElement, value: string): void {
    this._forceLog(`🎯 Filling SelectBox with value: "${value}"`);

    // Find the SelectBox container and button
    const selectBoxContainer =
      element.closest('[data-selectbox-value]') ||
      (element.hasAttribute('data-selectbox-value') ? element : null);

    if (!selectBoxContainer) {
      this._forceLog(`❌ SelectBox container not found`);
      return;
    }
    this._forceLog(`✅ Found SelectBox container`);

    // Find the trigger button for the dropdown
    const triggerButton = selectBoxContainer.querySelector(
      'button[data-value]'
    ) as HTMLButtonElement;
    if (!triggerButton) {
      this._forceLog(`❌ Trigger button not found`);
      return;
    }

    const currentValue = triggerButton.getAttribute('data-value');
    this._forceLog(`✅ Found trigger button with current value: "${currentValue}"`);

    // Check if the value is already set correctly
    if (currentValue && currentValue.toLowerCase() === value.toLowerCase()) {
      this._forceLog(`✅ Value "${value}" already set correctly, no need to change`);
      return;
    }

    // Click the button to open the dropdown
    this._forceLog(`🖱️ Clicking button to open dropdown`);
    triggerButton.click();

    // Wait a moment for the dropdown to open, then select the option
    setTimeout(() => {
      this._forceLog(`⏳ Looking for dropdown after timeout`);

      // Look for the dropdown options
      const dropdown =
        document.querySelector('[data-dropdown="dropdown"]') ||
        selectBoxContainer.querySelector('[role="listbox"]') ||
        document.querySelector('[class*="dropdown"][class*="open"]') ||
        document.querySelector('[class*="options"]');

      if (!dropdown) {
        this._forceLog(`❌ Dropdown not found after opening`);
        return;
      }
      this._forceLog(`✅ Found dropdown`);

      // Find the option to select
      let optionToSelect: HTMLElement | null = null;

      // Look for exact data-dropdown-value match (case-insensitive)
      optionToSelect = dropdown.querySelector(`[data-dropdown-value="${value}"]`) as HTMLElement;
      if (!optionToSelect) {
        // Try case-insensitive search
        const allOptions = dropdown.querySelectorAll('[data-dropdown-value]');
        optionToSelect = Array.from(allOptions).find(option => {
          const dataValue = option.getAttribute('data-dropdown-value');
          return dataValue && dataValue.toLowerCase() === value.toLowerCase();
        }) as HTMLElement;
      }

      if (optionToSelect) {
        this._forceLog(
          `✅ Found option by data-dropdown-value: "${optionToSelect.getAttribute('data-dropdown-value')}"`
        );
      }

      // Look for exact text content match
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

        if (optionToSelect) {
          this._forceLog(
            `✅ Found option by text content: "${optionToSelect.textContent?.trim()}"`
          );
        }
      }

      // Look for partial text match
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

        if (optionToSelect) {
          this._forceLog(
            `✅ Found option by partial match: "${optionToSelect.textContent?.trim()}"`
          );
        }
      }

      if (optionToSelect) {
        this._forceLog(`🖱️ Clicking option: "${optionToSelect.textContent?.trim()}"`);

        // Click the selected option
        optionToSelect.click();

        // Update the button's data-value attribute
        const selectedValue =
          optionToSelect.getAttribute('data-dropdown-value') ||
          optionToSelect.textContent?.trim() ||
          value;

        this._forceLog(`🔄 Updating button data-value to: "${selectedValue}"`);
        triggerButton.setAttribute('data-value', selectedValue);

        // Update button text
        const buttonTextElement = triggerButton.querySelector('[data-button-text]');
        if (buttonTextElement) {
          const newText = optionToSelect.textContent?.trim() || value;
          this._forceLog(`🔄 Updating button text to: "${newText}"`);
          buttonTextElement.textContent = newText;
          buttonTextElement.setAttribute('data-button-text', newText);
        }

        // Trigger change events
        this._forceLog(`📢 Triggering change events`);
        selectBoxContainer.dispatchEvent(new Event('change', { bubbles: true }));
        selectBoxContainer.dispatchEvent(
          new CustomEvent('select', {
            detail: { value: selectedValue },
            bubbles: true,
          })
        );

        this._forceLog(`✅ SelectBox fill completed successfully`);
      } else {
        this._forceLog(`❌ Option "${value}" not found in dropdown`);

        // Log all available options for debugging
        const allOptions = dropdown.querySelectorAll('[data-dropdown-value]');
        this._forceLog(
          `📋 Available options:`,
          Array.from(allOptions).map(opt => ({
            value: opt.getAttribute('data-dropdown-value'),
            text: opt.textContent?.trim(),
          }))
        );
      }
    }, 150); // Increased timeout slightly
  }

  private _batchFillFields(reactFormAPI: any, values: Record<string, unknown>): void {
    this._forceLog('📦 Batch filling fields using formApi.change()');
    if (reactFormAPI.batch) {
      reactFormAPI.batch(() => {
        for (const [fieldName, fieldValue] of Object.entries(values)) {
          try {
            reactFormAPI.change(fieldName, fieldValue);
            this._forceLog(`✅ Changed field "${fieldName}" to:`, fieldValue);
          } catch (error) {
            this._forceLog(`❌ Failed to change field "${fieldName}":`, error);
          }
        }
      });
    } else {
      // Fallback: change fields one by one
      for (const [fieldName, fieldValue] of Object.entries(values)) {
        try {
          reactFormAPI.change(fieldName, fieldValue);
          this._forceLog(`✅ Changed field "${fieldName}" to:`, fieldValue);
        } catch (error) {
          this._forceLog(`❌ Failed to change field "${fieldName}":`, error);
        }
      }
    }
  }

  private _fillFieldDirectly(formElement: HTMLFormElement, field: string, value: unknown): void {
    this._forceLog(`🔍 Direct DOM fill for field "${field}"`);
    const element = this._findFormField(formElement, field);

    if (element) {
      try {
        this._fillElementAdvanced(element, String(value));
      } catch (error) {
        this._forceLog(`❌ Advanced fill failed for "${field}", using basic fill`);
        // Fallback to basic filling for standard elements
        if (
          element.tagName.toLowerCase() === 'input' ||
          element.tagName.toLowerCase() === 'textarea' ||
          element.tagName.toLowerCase() === 'select'
        ) {
          (element as HTMLInputElement).value = String(value);
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    } else {
      this._forceLog(`❌ Field "${field}" not found for direct fill`);
    }
  }

  private async _submitFormDirectly(formElement: HTMLFormElement): Promise<void> {
    this._forceLog('📤 Direct form submission via DOM');
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

      // Try to find and click submit button first
      const submitButton = formElement.querySelector(
        'input[type="submit"], button[type="submit"], button:not([type])'
      ) as HTMLButtonElement;
      if (submitButton && !submitButton.disabled) {
        this._forceLog('🖱️ Clicking submit button');
        submitButton.click();
      } else {
        this._forceLog('📝 Using form.submit()');
        formElement.submit();
      }
    });
  }

  private _extractFormData(formElement: HTMLFormElement): Record<string, unknown> {
    const formData = new FormData(formElement);
    const values: Record<string, unknown> = {};

    for (const [key, value] of formData.entries()) {
      if (values[key]) {
        // Handle multiple values for same key (e.g., checkboxes)
        if (Array.isArray(values[key])) {
          (values[key] as unknown[]).push(value);
        } else {
          values[key] = [values[key], value];
        }
      } else {
        values[key] = value;
      }
    }

    return values;
  }

  // Debugging methods to help diagnose form detection issues
  private _logPageFormInfo(): void {
    const allForms = document.querySelectorAll('form');
    this._forceLog(`📋 Page Analysis: Found ${allForms.length} <form> elements on page`);

    allForms.forEach((form, index) => {
      const id = form.id || 'no-id';
      const name = form.name || 'no-name';
      const action = form.action || 'no-action';
      const method = form.method || 'GET';
      const fieldCount = form.querySelectorAll('input, textarea, select').length;

      this._forceLog(
        `  📝 Form ${index}: id="${id}", name="${name}", action="${action}", method="${method}", fields=${fieldCount}`
      );

      // Check for React fiber
      const reactKey = Object.keys(form).find(
        key => key.startsWith('__reactInternalInstance') || key.startsWith('__reactFiber')
      );

      if (reactKey) {
        this._forceLog(`    ⚛️ Has React fiber: ${reactKey}`);
      } else {
        this._forceLog(`    📄 No React fiber detected`);
      }
    });
  }

  private _logRegisteredFormDetails(): void {
    this._forceLog(`📊 Registered Forms Details (${this._forms.size} total):`);

    for (const [formId, formElement] of this._formElements) {
      const fields = this._extractFormFields(formElement);
      this._forceLog(`  📝 Form: ${formId}`);
      this._forceLog(`    📄 Action: ${formElement.action || 'none'}`);
      this._forceLog(`    🔧 Method: ${formElement.method}`);
      this._forceLog(`    📋 Fields (${fields.length}):`);

      fields.forEach(field => {
        this._forceLog(
          `      • ${field.name} (${field.type})${field.required ? ' *required' : ''}`
        );
      });
    }
  }

  private _findAlternativeFormMatch(
    fields: Record<string, string>
  ): { formApi: FormAPI; formId: string } | null {
    this._forceLog('🔍 Trying alternative matching strategies...');

    // Strategy 1: Try any form if we have any registered (relaxed matching)
    if (this._forms.size > 0) {
      const firstFormEntry = this._forms.entries().next().value;
      if (firstFormEntry) {
        const [formId, formApi] = firstFormEntry;
        this._forceLog(`✅ Using first available form: ${formId} (relaxed matching)`);
        return { formApi, formId };
      }
    }

    // Strategy 2: Look for forms with any input fields that might be fillable
    for (const [formId, formElement] of this._formElements) {
      const allInputs = formElement.querySelectorAll('input, textarea, select');
      if (allInputs.length > 0) {
        const formApi = this._forms.get(formId)!;
        this._forceLog(`✅ Found form with ${allInputs.length} input fields: ${formId}`);
        return { formApi, formId };
      }
    }

    return null;
  }

  private _logFieldMismatchDetails(fields: Record<string, string>): void {
    this._forceLog(`🔍 Field Mismatch Analysis:`);
    this._forceLog(`  🎯 Requested fields: ${Object.keys(fields).join(', ')}`);

    for (const [formId, formElement] of this._formElements) {
      const formFields = this._extractFormFields(formElement);
      const formFieldNames = formFields.map(f => f.name).filter(name => name.length > 0);

      this._forceLog(`  📝 Form ${formId} available fields: ${formFieldNames.join(', ')}`);

      // Show field matches
      const requestedFields = Object.keys(fields);
      const matches = requestedFields.filter(field => formFieldNames.includes(field));
      const misses = requestedFields.filter(field => !formFieldNames.includes(field));

      if (matches.length > 0) {
        this._forceLog(`    ✅ Matching fields: ${matches.join(', ')}`);
      }
      if (misses.length > 0) {
        this._forceLog(`    ❌ Missing fields: ${misses.join(', ')}`);
      }
    }
  }

  private _getFormSummary(): Array<{ formId: string; fieldCount: number; fieldNames: string[] }> {
    const summary: Array<{ formId: string; fieldCount: number; fieldNames: string[] }> = [];

    for (const [formId, formElement] of this._formElements) {
      const fields = this._extractFormFields(formElement);
      const fieldNames = fields.map(f => f.name).filter(name => name.length > 0);

      summary.push({
        formId,
        fieldCount: fields.length,
        fieldNames,
      });
    }

    return summary;
  }

  private _filterValidFields(fields: Record<string, string>): Record<string, string> {
    const validFields: Record<string, string> = {};

    for (const [fieldName, fieldValue] of Object.entries(fields)) {
      // Skip empty or whitespace-only field names
      if (!fieldName || fieldName.trim().length === 0) {
        this._forceLog(`⚠️ Skipping empty field name`);
        continue;
      }

      // Skip invalid field names (like "field-", "field--2")
      if (
        fieldName.startsWith('field-') &&
        (fieldName === 'field-' || fieldName.match(/^field--?\d*$/))
      ) {
        this._forceLog(`⚠️ Skipping invalid field name: "${fieldName}"`);
        continue;
      }

      // Skip empty values (but allow non-empty strings)
      if (fieldValue === null || fieldValue === undefined) {
        this._forceLog(`⚠️ Skipping field "${fieldName}" with null/undefined value`);
        continue;
      }

      // Allow empty strings for now - they might be intentional clears
      // Convert to string and trim
      const stringValue = String(fieldValue).trim();

      // Skip fields that are just empty strings if we want to be strict
      // For now, we'll allow them as they might be intentional field clears
      if (stringValue.length === 0) {
        this._forceLog(
          `⚠️ Field "${fieldName}" has empty value - allowing as potential field clear`
        );
      }

      validFields[fieldName] = fieldValue;
      this._forceLog(`✅ Valid field: "${fieldName}" = "${fieldValue}"`);
    }

    return validFields;
  }

  private async _fillFieldsIndividually(
    formApi: FormAPI,
    fields: Record<string, string>,
    filledFields: string[],
    failedFields: string[]
  ): Promise<void> {
    this._forceLog('🔄 Filling fields individually with batch operation');

    return new Promise<void>(resolve => {
      formApi.batch(() => {
        for (const [fieldName, fieldValue] of Object.entries(fields)) {
          try {
            this._forceLog(`🔄 Attempting to change field "${fieldName}" to "${fieldValue}"`);
            formApi.change(fieldName, fieldValue);
            filledFields.push(fieldName);
            this._forceLog(`✅ Successfully changed field "${fieldName}"`);
          } catch (error) {
            failedFields.push(fieldName);
            this._forceLog(`❌ Failed to change field "${fieldName}":`, error);
          }
        }
      });
      resolve();
    });
  }

  private _tryEnhancedFormDetector(fields: Record<string, string>): FormFillResult | null {
    try {
      this._forceLog('🔬 Initializing Enhanced Form Detector...');
      const enhancedDetector = new EnhancedFormDetector({
        autoDetect: true,
        debugMode: true,
        includeDisabled: false,
      });

      // Get all detected forms to see what we have
      const detectedForms = enhancedDetector.getForms();
      this._forceLog(`🔍 Enhanced detector found ${detectedForms.length} forms:`);
      
      detectedForms.forEach(form => {
        this._forceLog(`  📝 ${form.id} (${form.formLibrary})${form.formApi ? ' - WITH API' : ' - no API'}`);
        if (form.formApi) {
          this._forceLog(`    🔧 API methods:`, Object.keys(form.formApi));
        }
        this._forceLog(`    📋 Fields: ${Array.from(form.fields.keys()).join(', ')}`);
      });

      const success = enhancedDetector.fillAnyForm(fields);
      
      // Enhanced detector should succeed if it fills ANY fields, not just ALL fields
      // The "success" from fillAnyForm only indicates if it found a suitable form
      if (success !== false) {
        const validFieldCount = Object.keys(fields).filter(key => 
          key && key.trim().length > 0 && !key.match(/^field--?\d*$/)
        ).length;
        
        this._forceLog(`✅ Enhanced Form Detector filled form (${validFieldCount} valid fields attempted)`);
        return {
          success: true,
          fieldsCount: Object.keys(fields).length,
          filledFields: Object.keys(fields).filter(key => 
            key && key.trim().length > 0 && !key.match(/^field--?\d*$/)
          ),
          failedFields: Object.keys(fields).filter(key => 
            !key || key.trim().length === 0 || key.match(/^field--?\d*$/)
          ),
          formId: 'enhanced-detector-form',
        };
      } else {
        this._forceLog('❌ Enhanced Form Detector could not find suitable form');
        return null;
      }
    } catch (error) {
      this._forceLog('❌ Enhanced Form Detector encountered an error:', error);
      return null;
    }
  }
}
