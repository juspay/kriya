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
}