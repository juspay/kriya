/**
 * Enhanced Form Detection and Manipulation for Kriya
 * 
 * This module provides intelligent form detection for React Final Form,
 * Formik, and native HTML forms with proper API extraction.
 */

export interface EnhancedFormField {
  element: HTMLElement;
  elements?: HTMLElement[];
  name: string;
  type: string;
  value: string | boolean | string[];
  initialValue: string | boolean | string[]; // Track initial/default value
  label?: string;
  placeholder?: string;
  required: boolean;
  disabled: boolean;
  formLibrary?: 'react-final-form' | 'formik' | 'native' | 'unknown';
}

export interface EnhancedDetectedForm {
  element: HTMLFormElement | HTMLElement;
  id: string;
  name?: string;
  fields: Map<string, EnhancedFormField>;
  formLibrary: 'react-final-form' | 'formik' | 'native' | 'unknown';
  formApi?: any; // The form's API object (if detected)
}

export interface EnhancedFormDetectorConfig {
  autoDetect?: boolean;
  includeDisabled?: boolean;
  debugMode?: boolean;
  onFormDetected?: (form: EnhancedDetectedForm) => void;
  onFieldChanged?: (fieldName: string, value: any, form: EnhancedDetectedForm) => void;
}

export class EnhancedFormDetector {
  private forms: Map<string, EnhancedDetectedForm> = new Map();
  private config: EnhancedFormDetectorConfig;

  constructor(config: EnhancedFormDetectorConfig = {}) {
    this.config = {
      autoDetect: true,
      includeDisabled: false,
      debugMode: true,
      ...config
    };

    if (this.config.autoDetect) {
      this.detectAllForms();
    }
  }

  // Force logs to appear even if console.log is filtered
  private _forceLog(...args: any[]): void {
    if (!this.config.debugMode) return;
    console.log('🔍 KRIYA-ENHANCED:', ...args);
    console.info('🔍 KRIYA-ENHANCED:', ...args);
    console.warn('🔍 KRIYA-ENHANCED:', ...args);
    // Also try direct console access
    (window as any).console?.log?.('🔍 KRIYA-ENHANCED:', ...args);
  }

  /**
   * Detect all forms on the current page
   */
  public detectAllForms(): EnhancedDetectedForm[] {
    this._forceLog('🔍 Starting enhanced form detection...');
    const newForms: EnhancedDetectedForm[] = [];
    const detectedElements = new Set<HTMLElement>();
    
    // Detect React Final Form instances
    const reactFinalForms = this.detectReactFinalForms();
    newForms.push(...reactFinalForms);
    reactFinalForms.forEach(form => detectedElements.add(form.element));
    this._forceLog(`📊 React Final Form detection: found ${reactFinalForms.length} forms`);
    
    // Detect Formik forms
    const formikForms = this.detectFormikForms(detectedElements);
    newForms.push(...formikForms);
    formikForms.forEach(form => detectedElements.add(form.element));
    this._forceLog(`📊 Formik detection: found ${formikForms.length} forms`);
    
    // Detect native HTML forms (pass already detected elements)
    const nativeForms = this.detectNativeForms(detectedElements);
    newForms.push(...nativeForms);
    this._forceLog(`📊 Native form detection: found ${nativeForms.length} forms`);
    
    this._forceLog(`📊 Enhanced detection found ${newForms.length} forms total`);
    
    // Update internal forms map
    newForms.forEach(form => {
      const existingForm = this.forms.get(form.id);
      if (!existingForm) {
        this.forms.set(form.id, form);
        if (this.config.onFormDetected) {
          this.config.onFormDetected(form);
        }
        this._forceLog(`✅ Detected new form: ${form.id} (${form.formLibrary})`);
        if (form.formApi) {
          this._forceLog(`🚀 Form API available for ${form.id}:`, Object.keys(form.formApi));
        }
        return;
      }

      const mergedForm: EnhancedDetectedForm = {
        ...existingForm,
        ...form,
        fields: form.fields,
        formApi: form.formApi ?? existingForm.formApi,
      };
      this.forms.set(form.id, mergedForm);
      if (this.config.onFormDetected) {
        this.config.onFormDetected(mergedForm);
      }
      this._forceLog(`♻️ Updated form: ${form.id} (${mergedForm.formLibrary})`);
      if (mergedForm.formApi) {
        this._forceLog(`🚀 Form API available for ${form.id}:`, Object.keys(mergedForm.formApi));
      }
    });
    
    return Array.from(this.forms.values());
  }

  /**
   * Detect React Final Form instances using enhanced strategy
   */
  private detectReactFinalForms(): EnhancedDetectedForm[] {
    const forms: EnhancedDetectedForm[] = [];
    this._forceLog('🔍 Looking for React Final Form instances...');
    
    // Strategy 1: Look for standard HTML forms that might be React Final Forms
    const htmlForms = document.querySelectorAll('form');
    
    htmlForms.forEach((formElement, index) => {
      const reactInstance = this.getReactInstance(formElement);
      if (reactInstance) {
        this._forceLog(`🎯 Found React instance on form ${index}, analyzing...`);
        const formApi = this.extractReactFinalFormApi(reactInstance);
        
        if (formApi) {
          this._forceLog(`✅ Successfully extracted React Final Form API from form ${index}`);
          const formId = formElement.id || `react-final-form-${index}`;
          const fields = this.detectFieldsInContainer(formElement, 'react-final-form');
          
          const detectedForm: EnhancedDetectedForm = {
            element: formElement,
            id: formId,
            name: formElement.getAttribute('name') || undefined,
            fields,
            formLibrary: 'react-final-form',
            formApi
          };
          
          forms.push(detectedForm);
        }
      }
    });
    
    // Strategy 2: Look for React Final Form containers without form tags (enhanced selectors)
    const containers = document.querySelectorAll(
      '[data-react-final-form], .react-final-form, #generic-util-form, [id*="-form"], [id*="form-"]'
    );
    this._forceLog(`🔍 Found ${containers.length} potential React Final Form containers`);
    
    containers.forEach((container, index) => {
      const formElement = container as HTMLElement;
      const formId = formElement.id || `react-final-form-container-${index}`;
      
      this._forceLog(`🔍 Checking container ${index}: ${formElement.tagName}#${formElement.id || 'no-id'}`);
      
      const reactInstance = this.getReactInstance(formElement);
      let formApi = null;
      
      if (reactInstance) {
        formApi = this.extractReactFinalFormApi(reactInstance);
      }
      
      if (formApi) {
        this._forceLog(`✅ Found React Final Form API in container: ${formId}`);
        const fields = this.detectFieldsInContainer(formElement, 'react-final-form');
        
        const detectedForm: EnhancedDetectedForm = {
          element: formElement,
          id: formId,
          name: formElement.getAttribute('name') || undefined,
          fields,
          formLibrary: 'react-final-form',
          formApi
        };
        
        forms.push(detectedForm);
      } else {
        this._forceLog(`❌ No React Final Form API found in container: ${formId}`);
      }
    });
    
    // Strategy 3: Search ALL elements for useForm() hooks (specific to user's pattern)
    this._forceLog('🔍 Searching ALL elements for useForm() hooks...');
    const allElements = document.querySelectorAll('*');
    let foundFormApis = 0;
    
    allElements.forEach((element, index) => {
      const reactInstance = this.getReactInstance(element as HTMLElement);
      if (reactInstance) {
        const formApi = this.searchForUseFormHook(reactInstance);
        if (formApi) {
          foundFormApis++;
          this._forceLog(`✅ Found useForm() hook #${foundFormApis} on element ${index} (${element.tagName})`);
          this._forceLog(`🔍 useForm() API methods:`, Object.keys(formApi));
          
          // Find the nearest form element or use this element
          const formElement = element.closest('form') || element as HTMLElement;
          const formId = formElement.id || `react-final-form-usehook-${foundFormApis}`;
          const fields = this.detectFieldsInContainer(formElement, 'react-final-form');
          
          const detectedForm: EnhancedDetectedForm = {
            element: formElement,
            id: formId,
            name: formElement.getAttribute('name') || undefined,
            fields,
            formLibrary: 'react-final-form',
            formApi
          };
          
          forms.push(detectedForm);
          this._forceLog(`🚀 Registered React Final Form: ${formId} with API`);
        }
      }
    });
    
    this._forceLog(`📊 Found ${foundFormApis} useForm() hooks total`);
    
    this._forceLog(`📋 Found ${forms.length} React Final Form instances`);
    return forms;
  }
  
  /**
   * Specifically search for useForm() hook pattern
   */
  private searchForUseFormHook(reactInstance: any): any {
    if (!reactInstance) return null;
    
    // Check if this component is using useForm() hook
    if (reactInstance.memoizedState) {
      let hook = reactInstance.memoizedState;
      while (hook) {
        // Look for the specific useForm hook signature
        if (hook.memoizedState && typeof hook.memoizedState === 'object') {
          const state = hook.memoizedState;
          
          // Check if this looks like React Final Form API
          if (state.change && state.submit && state.batch && state.getState) {
            this._forceLog(`🎯 Found useForm() hook with methods:`, Object.keys(state));
            return state;
          }
          
          // Check for nested form API
          if (state.form && state.form.change && state.form.submit) {
            this._forceLog(`🎯 Found nested form API in useForm() hook`);
            return state.form;
          }
        }
        hook = hook.next;
      }
    }
    
    // Check component props for finalFormInstanceHolder
    if (reactInstance.memoizedProps?.finalFormInstanceHolder) {
      this._forceLog(`🎯 Found finalFormInstanceHolder prop - this component uses React Final Form`);
      // The form API should be in the hooks
      return this.searchForUseFormHook(reactInstance);
    }
    
    return null;
  }

  /**
   * Detect Formik forms
   */
  private detectFormikForms(alreadyDetectedElements: Set<HTMLElement> = new Set()): EnhancedDetectedForm[] {
    const forms: EnhancedDetectedForm[] = [];
    this._forceLog('🔍 Looking for Formik instances...');
    
    // Look for Formik containers
    const formContainers = document.querySelectorAll('[data-formik], .formik-form');
    
    formContainers.forEach((container, index) => {
      const formElement = container as HTMLElement;
      const formId = formElement.id || `formik-form-${index}`;
      
      const reactInstance = this.getReactInstance(formElement);
      let formApi = null;
      
      if (reactInstance) {
        formApi = this.extractFormikApi(reactInstance);
      }
      
      const fields = this.detectFieldsInContainer(formElement, 'formik');
      
      const detectedForm: EnhancedDetectedForm = {
        element: formElement,
        id: formId,
        name: formElement.getAttribute('name') || undefined,
        fields,
        formLibrary: 'formik',
        formApi
      };
      
      forms.push(detectedForm);
    });
    
    this._forceLog(`📋 Found ${forms.length} Formik instances`);
    return forms;
  }

  /**
   * Detect native HTML forms (only check forms not already detected by other libraries)
   */
  private detectNativeForms(alreadyDetectedElements: Set<HTMLElement> = new Set()): EnhancedDetectedForm[] {
    const forms: EnhancedDetectedForm[] = [];
    this._forceLog('🔍 Looking for native HTML forms...');
    
    const formElements = document.querySelectorAll('form');
    
    this._forceLog(`📊 Total <form> elements: ${formElements.length}, Already detected: ${alreadyDetectedElements.size}`);
    
    formElements.forEach((formElement, index) => {
      // Skip if this exact element was already detected as React Final Form, Formik, etc.
      if (alreadyDetectedElements.has(formElement)) {
        this._forceLog(`⏭️ Form element already detected by previous detection phases - skipping native detection`);
        return;
      }
      
      const formId = formElement.id || `native-form-${index}`;
      this._forceLog(`🔍 Checking undetected form: ${formId}`);
      
      const fields = this.detectFieldsInContainer(formElement, 'native');
      
      // Skip if no fields were detected
      if (fields.size === 0) {
        this._forceLog(`⏭️ Form ${formId} has no detectable fields - skipping`);
        return;
      }
      
      const detectedForm: EnhancedDetectedForm = {
        element: formElement,
        id: formId,
        name: formElement.name || undefined,
        fields,
        formLibrary: 'native'
      };
      
      forms.push(detectedForm);
      this._forceLog(`✅ Detected native form: ${formId} with ${fields.size} fields`);
    });
    
    this._forceLog(`📋 Found ${forms.length} new native HTML forms`);
    return forms;
  }

  /**
   * Detect form fields within a container using comprehensive selectors
   */
  private detectFieldsInContainer(container: HTMLElement, formLibrary: string): Map<string, EnhancedFormField> {
    const fields = new Map<string, EnhancedFormField>();
    
    // Enhanced field selectors including ReScript/Euler patterns
    const fieldSelectors = [
      'input[type="text"]',
      'input[type="email"]',
      'input[type="password"]',
      'input[type="number"]',
      'input[type="tel"]',
      'input[type="url"]',
      'input[type="search"]',
      'input[type="date"]',
      'input[type="time"]',
      'input[type="datetime-local"]',
      'input[type="checkbox"]',
      'input[type="radio"]',
      'input[name]', // Any input with a name
      'select',
      'textarea',
      '[contenteditable="true"]',
      // ReScript/Euler specific patterns
      '[data-component-field-wrapper] input',
      '[data-component-field-wrapper] select',
      '[data-component-field-wrapper] textarea',
      '[data-selectbox-value] button[data-value]'
    ];
    
    fieldSelectors.forEach(selector => {
      const elements = container.querySelectorAll(selector);
      elements.forEach(element => {
        const field = this.createFormField(element as HTMLElement, formLibrary);
        if (field && (this.config.includeDisabled || !field.disabled)) {
          const existingField = fields.get(field.name);
          if (
            existingField &&
            (field.type === 'checkbox' || field.type === 'radio') &&
            existingField.type === field.type
          ) {
            const existingElements = existingField.elements ?? [existingField.element];
            const mergedElements = [...existingElements, field.element];
            existingField.elements = mergedElements;

            if (field.type === 'checkbox') {
              const checkedValues = mergedElements
                .filter(el => (el as HTMLInputElement).checked)
                .map(el => (el as HTMLInputElement).value);
              existingField.value = checkedValues;
              existingField.initialValue = checkedValues;
            } else {
              const checkedRadio = mergedElements.find(
                el => (el as HTMLInputElement).checked
              ) as HTMLInputElement | undefined;
              existingField.value = checkedRadio ? checkedRadio.value : '';
              existingField.initialValue = existingField.value;
            }

            existingField.required = existingField.required || field.required;
            existingField.disabled = existingField.disabled && field.disabled;

            this._forceLog(
              `🔍 Field grouped: "${field.name}" (${field.type}) with ${mergedElements.length} elements in ${formLibrary} form`
            );
          } else {
            if (field.type === 'checkbox' || field.type === 'radio') {
              field.elements = [field.element];
            }
            fields.set(field.name, field);
            this._forceLog(`🔍 Field detected: "${field.name}" (${field.type}) in ${formLibrary} form`);
          }
        }
      });
    });
    
    return fields;
  }

  /**
   * Create a FormField object from an HTML element with enhanced detection
   */
  private createFormField(element: HTMLElement, formLibrary: string): EnhancedFormField | null {
    // Handle ReScript SelectBox components
    if (element.hasAttribute('data-value') && element.tagName === 'BUTTON') {
      const container = element.closest('[data-component-field-wrapper]');
      if (container) {
        const name = container.getAttribute('data-component-field-wrapper') || element.id || 'unknown';
        const value = element.getAttribute('data-value') || '';
        const cleanName = name.replace(/^field-/, ''); // Remove field- prefix
        
        // Get initial value for SelectBox
        const initialValue = this.extractInitialValue(element, cleanName, formLibrary);
        
        return {
          element,
          name: cleanName,
          type: 'selectbox',
          value,
          initialValue,
          required: element.hasAttribute('required'),
          disabled: element.hasAttribute('disabled'),
          formLibrary: formLibrary as any
        };
      }
    }
    
    const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    
    // Get field name with multiple strategies
    let name = input.name || input.id;
    
    // If no name, try to get from wrapper
    if (!name) {
      const wrapper = element.closest('[data-component-field-wrapper]');
      if (wrapper) {
        name = wrapper.getAttribute('data-component-field-wrapper') || '';
        name = name.replace(/^field-/, ''); // Remove field- prefix
      }
    }
    
    if (!name) {
      this._forceLog(`⚠️ Skipping element without name/id:`, element);
      return null; // Skip elements without identifiers
    }
    
    const type = input.type || input.tagName.toLowerCase();
    
    let value: string | boolean | string[];
    
    if (input.type === 'checkbox') {
      value = (input as HTMLInputElement).checked;
    } else if (input.type === 'radio') {
      value = (input as HTMLInputElement).checked ? input.value : '';
    } else if (input.tagName === 'SELECT' && (input as HTMLSelectElement).multiple) {
      const select = input as HTMLSelectElement;
      value = Array.from(select.selectedOptions).map(option => option.value);
    } else {
      value = input.value || '';
    }
    
    // Extract initial value based on form library
    const initialValue = this.extractInitialValue(input, name, formLibrary);
    
    // Find associated label with multiple strategies
    let label: string | undefined;
    
    // Strategy 1: Label with for attribute
    if (input.id) {
      const labelElement = document.querySelector(`label[for="${input.id}"]`);
      if (labelElement) {
        label = labelElement.textContent?.trim();
      }
    }
    
    // Strategy 2: Parent label
    if (!label) {
      const parentLabel = input.closest('label');
      if (parentLabel) {
        label = parentLabel.textContent?.trim();
      }
    }
    
    // Strategy 3: Sibling label
    if (!label) {
      const siblingLabel = input.parentElement?.querySelector('label');
      if (siblingLabel) {
        label = siblingLabel.textContent?.trim();
      }
    }
    
    return {
      element: input,
      name,
      type,
      value,
      initialValue,
      label,
      placeholder: 'placeholder' in input ? input.placeholder : undefined,
      required: input.required,
      disabled: input.disabled,
      formLibrary: formLibrary as any
    };
  }

  /**
   * Extract initial value from React Final Form, Formik, or native HTML forms
   */
  private extractInitialValue(
    element: HTMLElement,
    fieldName: string,
    formLibrary: string
  ): string | boolean | string[] {
    // Try different strategies based on form library
    if (formLibrary === 'react-final-form') {
      const reactInitialValue = this.extractReactFinalFormInitialValue(element, fieldName);
      if (reactInitialValue !== null) {
        return reactInitialValue;
      }
    } else if (formLibrary === 'formik') {
      const formikInitialValue = this.extractFormikInitialValue(element, fieldName);
      if (formikInitialValue !== null) {
        return formikInitialValue;
      }
    }
    
    // Fallback to native HTML initial values
    return this.extractNativeInitialValue(element);
  }

  /**
   * Extract initial value from React Final Form with enhanced detection
   */
  private extractReactFinalFormInitialValue(
    element: HTMLElement,
    fieldName: string
  ): string | boolean | string[] | null {
    this._forceLog(`🔍 Extracting React Final Form initial value for field: ${fieldName}`);
    
    // Strategy 1: Find form API from the element itself
    const reactInstance = this.getReactInstance(element);
    if (reactInstance) {
      const formApi = this.extractReactFinalFormApi(reactInstance);
      if (formApi) {
        this._forceLog(`✅ Found form API for field ${fieldName}, checking state...`);
        
        if (formApi.getState) {
          try {
            const state = formApi.getState();
            this._forceLog(`🔍 Form state for ${fieldName}:`, {
              hasInitialValues: !!state.initialValues,
              initialValuesKeys: state.initialValues ? Object.keys(state.initialValues) : [],
              hasFieldInInitialValues: state.initialValues && fieldName in state.initialValues,
              fieldInitialValue: state.initialValues?.[fieldName],
              allInitialValues: state.initialValues
            });
            
            if (state.initialValues && fieldName in state.initialValues) {
              this._forceLog(`✅ Found React Final Form initial value for ${fieldName}:`, state.initialValues[fieldName]);
              return state.initialValues[fieldName];
            } else {
              this._forceLog(`⚠️ Field ${fieldName} not found in initialValues or initialValues is empty`);
            }
          } catch (error) {
            this._forceLog(`❌ Error calling getState() for ${fieldName}:`, error);
          }
        } else {
          this._forceLog(`⚠️ Form API found but no getState() method for ${fieldName}`);
        }
      } else {
        this._forceLog(`⚠️ No form API found for field ${fieldName}`);
      }
    }
    
    // Strategy 2: Search for form API in the form container/parent elements
    let container = element.closest('form') || element.closest('[data-react-final-form]') || element.closest('[id*="form"]');
    if (container) {
      this._forceLog(`🔍 Searching for form API in container for field ${fieldName}`);
      const containerReactInstance = this.getReactInstance(container as HTMLElement);
      if (containerReactInstance) {
        const containerFormApi = this.extractReactFinalFormApi(containerReactInstance);
        if (containerFormApi && containerFormApi.getState) {
          try {
            const state = containerFormApi.getState();
            this._forceLog(`🔍 Container form state for ${fieldName}:`, {
              hasInitialValues: !!state.initialValues,
              fieldValue: state.initialValues?.[fieldName]
            });
            
            if (state.initialValues && fieldName in state.initialValues) {
              this._forceLog(`✅ Found React Final Form initial value in container for ${fieldName}:`, state.initialValues[fieldName]);
              return state.initialValues[fieldName];
            }
          } catch (error) {
            this._forceLog(`❌ Error getting state from container for ${fieldName}:`, error);
          }
        }
      }
    }
    
    // Strategy 3: Look for useFormState hook patterns in React tree
    const formStateValue = this.searchForFormStateInReactTree(element, fieldName);
    if (formStateValue !== null) {
      this._forceLog(`✅ Found initial value via React hook search for ${fieldName}:`, formStateValue);
      return formStateValue;
    }
    
    this._forceLog(`❌ Could not find React Final Form initial value for ${fieldName}, falling back to DOM`);
    return null;
  }
  
  /**
   * Search for form state in React component tree (enhanced hook detection)
   */
  private searchForFormStateInReactTree(element: HTMLElement, fieldName: string): any {
    this._forceLog(`🔍 Searching React tree for form state containing ${fieldName}`);
    
    // Search broader React tree for form state
    const allElements = [element];
    
    // Add parent elements
    let parent = element.parentElement;
    while (parent && allElements.length < 10) {
      allElements.push(parent);
      parent = parent.parentElement;
    }
    
    // Add sibling containers that might have form context
    const containers = document.querySelectorAll('[id*="form"], [class*="form"], form');
    containers.forEach(container => {
      if (allElements.length < 20) {
        allElements.push(container as HTMLElement);
      }
    });
    
    for (const el of allElements) {
      const reactInstance = this.getReactInstance(el);
      if (reactInstance) {
        // Search for useFormState hook patterns
        const formState = this.searchHooksForFormState(reactInstance, fieldName);
        if (formState !== null) {
          return formState;
        }
        
        // Search for form context
        const contextState = this.searchContextForFormState(reactInstance, fieldName);
        if (contextState !== null) {
          return contextState;
        }
      }
    }
    
    return null;
  }
  
  /**
   * Search React hooks for form state
   */
  private searchHooksForFormState(reactInstance: any, fieldName: string): any {
    if (!reactInstance?.memoizedState) return null;
    
    let hook = reactInstance.memoizedState;
    while (hook) {
      if (hook.memoizedState) {
        // Check if this looks like useFormState result
        if (hook.memoizedState.initialValues && fieldName in hook.memoizedState.initialValues) {
          this._forceLog(`✅ Found initial value in React hook for ${fieldName}:`, hook.memoizedState.initialValues[fieldName]);
          return hook.memoizedState.initialValues[fieldName];
        }
        
        // Check if this is a form state object
        if (typeof hook.memoizedState === 'object' && hook.memoizedState.values && hook.memoizedState.initialValues) {
          if (fieldName in hook.memoizedState.initialValues) {
            this._forceLog(`✅ Found initial value in form state hook for ${fieldName}:`, hook.memoizedState.initialValues[fieldName]);
            return hook.memoizedState.initialValues[fieldName];
          }
        }
      }
      hook = hook.next;
    }
    
    return null;
  }
  
  /**
   * Search React context for form state
   */
  private searchContextForFormState(reactInstance: any, fieldName: string): any {
    if (!reactInstance?.dependencies?.firstContext) return null;
    
    let context = reactInstance.dependencies.firstContext;
    while (context) {
      if (context.memoizedValue) {
        // Check if context contains initialValues
        if (context.memoizedValue.initialValues && fieldName in context.memoizedValue.initialValues) {
          this._forceLog(`✅ Found initial value in React context for ${fieldName}:`, context.memoizedValue.initialValues[fieldName]);
          return context.memoizedValue.initialValues[fieldName];
        }
        
        // Check nested form state in context
        if (context.memoizedValue.form?.getState) {
          try {
            const state = context.memoizedValue.form.getState();
            if (state.initialValues && fieldName in state.initialValues) {
              this._forceLog(`✅ Found initial value in context form API for ${fieldName}:`, state.initialValues[fieldName]);
              return state.initialValues[fieldName];
            }
          } catch (error) {
            // Ignore errors
          }
        }
      }
      context = context.next;
    }
    
    return null;
  }

  /**
   * Extract initial value from Formik
   */
  private extractFormikInitialValue(
    element: HTMLElement,
    fieldName: string
  ): string | boolean | string[] | null {
    // Try to find Formik's initialValues
    const reactInstance = this.getReactInstance(element);
    if (reactInstance) {
      const formikApi = this.extractFormikApi(reactInstance);
      if (formikApi && formikApi.initialValues && fieldName in formikApi.initialValues) {
        this._forceLog(`🔍 Found Formik initial value for ${fieldName}:`, formikApi.initialValues[fieldName]);
        return formikApi.initialValues[fieldName];
      }
    }
    return null;
  }

  /**
   * Extract initial value from native HTML forms
   */
  private extractNativeInitialValue(element: HTMLElement): string | boolean | string[] {
    const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    
    // For native forms, use HTML attributes and defaults
    if (input.type === 'checkbox') {
      return (input as HTMLInputElement).defaultChecked;
    } else if (input.type === 'radio') {
      return (input as HTMLInputElement).defaultChecked
        ? (input as HTMLInputElement).defaultValue
        : '';
    } else if (input.tagName === 'SELECT') {
      const select = input as HTMLSelectElement;
      if (select.multiple) {
        return Array.from(select.options)
          .filter(option => option.defaultSelected)
          .map(option => option.value);
      } else {
        // For single select, find the default selected option
        const defaultOption = Array.from(select.options).find(
          option => option.defaultSelected
        );
        return defaultOption ? defaultOption.value : '';
      }
    } else if (input.tagName === 'TEXTAREA') {
      return (input as HTMLTextAreaElement).defaultValue || '';
    } else if (element.tagName === 'BUTTON' && element.hasAttribute('data-value')) {
      // For ReScript SelectBox, try to get original data-value
      return element.getAttribute('data-value') || '';
    } else {
      // For regular input elements
      return (input as HTMLInputElement).defaultValue || '';
    }
  }

  /**
   * Set a field value using the appropriate method for the form library
   */
  public setFieldValue(formId: string, fieldName: string, value: any): boolean {
    const form = this.forms.get(formId);
    if (!form) {
      this._forceLog(`❌ Form not found: ${formId}`);
      return false;
    }
    
    const field = form.fields.get(fieldName);
    if (!field) {
      this._forceLog(`❌ Field not found: ${fieldName} in form ${formId}`);
      return false;
    }
    
    this._forceLog(`🔄 Setting ${fieldName} = "${value}" in ${form.formLibrary} form`);
    
    try {
      switch (form.formLibrary) {
        case 'react-final-form':
          return this.setReactFinalFormValue(form, fieldName, value);
        case 'formik':
          return this.setFormikValue(form, fieldName, value);
        case 'native':
          return this.setNativeFormValue(field, value);
        default:
          this._forceLog(`⚠️ Unknown form library: ${form.formLibrary}, using native fallback`);
          return this.setNativeFormValue(field, value);
      }
    } catch (error) {
      this._forceLog(`❌ Error setting field value: ${error}`);
      return false;
    }
  }

  /**
   * Set React Final Form field value
   */
  private setReactFinalFormValue(form: EnhancedDetectedForm, fieldName: string, value: any): boolean {
    if (form.formApi && form.formApi.change) {
      this._forceLog(`✨ Using React Final Form API change() for ${fieldName}`);
      try {
        // Parse JSON strings to actual JavaScript values
        let processedValue = value;
        if (typeof value === 'string' && value.trim().length > 0) {
          try {
            // Check if it's a JSON string (starts with [ { or ")
            if (value.trim().match(/^[\[{"]/) || value === 'true' || value === 'false' || value === 'null') {
              const parsed = JSON.parse(value);
              this._forceLog(`🔄 Parsed JSON string for ${fieldName}: "${value}" → ${Array.isArray(parsed) ? `[${parsed.join(', ')}]` : typeof parsed === 'object' ? 'object' : parsed}`);
              processedValue = parsed;
            }
          } catch (parseError) {
            // If parsing fails, use original value
            this._forceLog(`⚠️ Could not parse JSON for ${fieldName}, using as string: "${value}"`);
          }
        }
        
        // Pass the actual JavaScript value to React Final Form (NOT stringified)
        form.formApi.change(fieldName, processedValue);
        this.triggerFieldChange(form, fieldName, processedValue);
        
        // Log the actual value type being set
        const valueDisplay = Array.isArray(processedValue) 
          ? `[${processedValue.join(', ')}] (array)` 
          : typeof processedValue === 'object' 
            ? `{object} (${Object.keys(processedValue).length} keys)`
            : `"${processedValue}" (${typeof processedValue})`;
        
        this._forceLog(`✅ Successfully set ${fieldName} = ${valueDisplay} via React Final Form API`);
        return true;
      } catch (error) {
        this._forceLog(`❌ React Final Form API change() failed for ${fieldName}:`, error);
        this._forceLog(`⚠️ Falling back to DOM manipulation`);
      }
    } else {
      this._forceLog(`⚠️ No React Final Form API available, falling back to DOM manipulation`);
    }
    
    // Fallback to direct DOM manipulation
    const field = form.fields.get(fieldName);
    if (field) {
      return this.setNativeFormValue(field, value);
    }
    
    return false;
  }

  /**
   * Set Formik field value
   */
  private setFormikValue(form: EnhancedDetectedForm, fieldName: string, value: any): boolean {
    if (form.formApi && form.formApi.setFieldValue) {
      this._forceLog(`✨ Using Formik API setFieldValue() for ${fieldName}`);
      form.formApi.setFieldValue(fieldName, value);
      this.triggerFieldChange(form, fieldName, value);
      return true;
    }
    
    this._forceLog(`⚠️ No Formik API available, falling back to DOM manipulation`);
    // Fallback to direct DOM manipulation
    const field = form.fields.get(fieldName);
    if (field) {
      return this.setNativeFormValue(field, value);
    }
    
    return false;
  }

  /**
   * Set native form field value with enhanced support for ReScript components
   */
  private setNativeFormValue(field: EnhancedFormField, value: any): boolean {
    const element = field.element;
    const elements = field.elements ?? [field.element];
    
    // Handle ReScript SelectBox components
    if (field.type === 'selectbox' && element.tagName === 'BUTTON') {
      return this.setReScriptSelectBoxValue(element as HTMLButtonElement, value);
    }
    
    const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    
    if (field.type === 'checkbox') {
      if (elements.length > 1) {
        if (Array.isArray(value)) {
          elements.forEach(el => {
            const checkbox = el as HTMLInputElement;
            checkbox.checked = value.includes(checkbox.value);
          });
        } else if (typeof value === 'string') {
          elements.forEach(el => {
            const checkbox = el as HTMLInputElement;
            checkbox.checked = checkbox.value === value;
          });
        } else {
          elements.forEach(el => {
            (el as HTMLInputElement).checked = Boolean(value);
          });
        }
      } else {
        (input as HTMLInputElement).checked = Boolean(value);
      }
    } else if (field.type === 'radio') {
      if (elements.length > 1) {
        elements.forEach(el => {
          const radio = el as HTMLInputElement;
          radio.checked = radio.value === value;
        });
      } else {
        if (input.value === value) {
          (input as HTMLInputElement).checked = true;
        }
      }
    } else if (field.type === 'select-multiple') {
      const select = input as HTMLSelectElement;
      const values = Array.isArray(value) ? value : [value];
      Array.from(select.options).forEach(option => {
        option.selected = values.includes(option.value);
      });
    } else {
      input.value = String(value);
    }
    
    // Trigger events to notify React/other libraries
    this.triggerEvents(element);
    
    this._forceLog(`✅ Set ${field.name} = "${value}" via DOM manipulation`);
    return true;
  }

  /**
   * Handle ReScript SelectBox components specifically
   */
  private setReScriptSelectBoxValue(button: HTMLButtonElement, value: string): boolean {
    this._forceLog(`🎯 Setting ReScript SelectBox to "${value}"`);
    
    const container = button.closest('[data-component-field-wrapper]') || 
                     button.closest('[data-selectbox-value]');
    
    if (!container) {
      this._forceLog(`❌ SelectBox container not found`);
      return false;
    }
    
    const currentValue = button.getAttribute('data-value');
    if (currentValue && currentValue.toLowerCase() === value.toLowerCase()) {
      this._forceLog(`✅ Value "${value}" already set correctly`);
      return true;
    }
    
    // Click to open dropdown
    this._forceLog(`🖱️ Clicking SelectBox to open dropdown`);
    button.click();
    
    // Wait and select option with enhanced dropdown detection
    setTimeout(() => {
      // Enhanced dropdown selectors for ReScript/Euler components
      const dropdown = document.querySelector('[data-dropdown="dropdown"]') ||
                      container.querySelector('[role="listbox"]') ||
                      document.querySelector('[class*="dropdown"][class*="open"]') ||
                      document.querySelector('[data-dropdown-container]') ||
                      document.querySelector('.dropdown-menu') ||
                      document.querySelector('[role="menu"]') ||
                      // Look for any recently added dropdown-like elements
                      Array.from(document.querySelectorAll('div')).find(div => {
                        const style = window.getComputedStyle(div);
                        return style.position === 'absolute' && 
                               style.zIndex && 
                               parseInt(style.zIndex) > 1000 &&
                               div.querySelectorAll('[data-dropdown-value]').length > 0;
                      });
      
      if (dropdown) {
        this._forceLog(`✅ Found dropdown, looking for option "${value}"`);
        
        // Find option with case-insensitive search
        let option = dropdown.querySelector(`[data-dropdown-value="${value}"]`) as HTMLElement;
        if (!option) {
          const allOptions = dropdown.querySelectorAll('[data-dropdown-value]');
          option = Array.from(allOptions).find(opt => {
            const dataValue = opt.getAttribute('data-dropdown-value');
            return dataValue && dataValue.toLowerCase() === value.toLowerCase();
          }) as HTMLElement;
        }
        
        if (option) {
          this._forceLog(`🖱️ Clicking option: "${option.getAttribute('data-dropdown-value')}"`);
          option.click();
          
          // Update button attributes
          const selectedValue = option.getAttribute('data-dropdown-value') || value;
          button.setAttribute('data-value', selectedValue);
          
          // Update button text
          const buttonText = button.querySelector('[data-button-text]');
          if (buttonText) {
            buttonText.textContent = option.textContent?.trim() || value;
          }
          
          // Trigger events
          container.dispatchEvent(new Event('change', { bubbles: true }));
          this._forceLog(`✅ SelectBox successfully set to "${selectedValue}"`);
        } else {
          this._forceLog(`❌ Option "${value}" not found in dropdown`);
        }
      } else {
        this._forceLog(`❌ Dropdown not found after clicking`);
      }
    }, 100);
    
    return true;
  }

  /**
   * Trigger appropriate events on form elements
   */
  private triggerEvents(element: HTMLElement): void {
    const events = ['input', 'change', 'blur'];
    
    events.forEach(eventType => {
      const event = new Event(eventType, { bubbles: true, cancelable: true });
      element.dispatchEvent(event);
    });
    
    // Also trigger React synthetic events
    const reactEvent = new Event('input', { bubbles: true });
    Object.defineProperty(reactEvent, 'target', { value: element });
    element.dispatchEvent(reactEvent);
  }

  /**
   * Trigger field change callback
   */
  private triggerFieldChange(form: EnhancedDetectedForm, fieldName: string, value: any): void {
    if (this.config.onFieldChanged) {
      this.config.onFieldChanged(fieldName, value, form);
    }
  }

  /**
   * Get React instance from DOM element with enhanced detection
   */
  private getReactInstance(element: HTMLElement): any {
    // Try different React instance keys
    const reactKeys = Object.keys(element).filter(key => 
      key.startsWith('__reactInternalInstance') || 
      key.startsWith('__reactFiber') ||
      key.startsWith('_reactInternalFiber')
    );
    
    if (reactKeys.length > 0) {
      const reactKey = reactKeys[0];
      if (reactKey) {
        this._forceLog(`🎯 Found React instance key: ${reactKey}`);
        return (element as any)[reactKey];
      }
    }
    
    return null;
  }

  /**
   * Extract React Final Form API from React instance with enhanced navigation
   */
  private extractReactFinalFormApi(reactInstance: any): any {
    this._forceLog('🔍 Extracting React Final Form API...');
    
    // Strategy 1: Breadth-first search through the entire component tree
    const visited = new Set();
    const queue = [reactInstance];
    let depth = 0;
    const maxDepth = 30; // Increased depth
    
    while (queue.length > 0 && depth < maxDepth) {
      const batchSize = queue.length;
      this._forceLog(`🔍 Searching depth ${depth} with ${batchSize} components`);
      
      for (let i = 0; i < batchSize; i++) {
        const current = queue.shift();
        if (!current || visited.has(current)) continue;
        visited.add(current);
        
        // Check current node for form API
        const formApi = this.checkNodeForFormApi(current, depth);
        if (formApi) return formApi;
        
        // Add children to queue for next depth level
        if (current.child) queue.push(current.child);
        if (current.sibling) queue.push(current.sibling);
        if (current.return) queue.push(current.return);
      }
      depth++;
    }
    
    this._forceLog(`❌ Could not find React Final Form API after ${depth} levels`);
    return null;
  }

  /**
   * Check a single React fiber node for form API
   */
  private checkNodeForFormApi(node: any, depth: number): any {
    if (!node) return null;
    
    // Strategy 1: Direct form API in memoizedProps
    if (node.memoizedProps?.form) {
      this._forceLog(`✅ Found form API in memoizedProps at depth ${depth}`);
      this._forceLog(`🔍 Form API methods:`, Object.keys(node.memoizedProps.form));
      return node.memoizedProps.form;
    }
    
    // Strategy 2: Form API in render function/render props
    if (node.memoizedProps?.render) {
      const renderProp = node.memoizedProps.render;
      if (typeof renderProp === 'function') {
        // This might be a render prop function that receives form API
        this._forceLog(`🔍 Found render prop function at depth ${depth}`);
      } else if (typeof renderProp === 'object' && renderProp.form) {
        this._forceLog(`✅ Found form API in render props at depth ${depth}`);
        return renderProp.form;
      }
    }
    
    // Strategy 3: Form API in children props
    if (node.memoizedProps?.children && typeof node.memoizedProps.children === 'function') {
      this._forceLog(`🔍 Found children render prop at depth ${depth}`);
    }
    
    // Strategy 4: Form API in state node
    if (node.stateNode) {
      if (node.stateNode.form) {
        this._forceLog(`✅ Found form API in stateNode at depth ${depth}`);
        return node.stateNode.form;
      }
      
      // Check for form methods directly on state node
      if (node.stateNode.change && node.stateNode.submit && node.stateNode.batch) {
        this._forceLog(`✅ Found form API methods directly on stateNode at depth ${depth}`);
        return node.stateNode;
      }
    }
    
    // Strategy 5: React Final Form context
    if (node.dependencies?.firstContext) {
      let context = node.dependencies.firstContext;
      while (context) {
        if (context.memoizedValue) {
          if (context.memoizedValue.form) {
            this._forceLog(`✅ Found form API in React context at depth ${depth}`);
            return context.memoizedValue.form;
          }
          if (context.memoizedValue.change && context.memoizedValue.submit) {
            this._forceLog(`✅ Found form API directly in React context at depth ${depth}`);
            return context.memoizedValue;
          }
        }
        context = context.next;
      }
    }
    
    // Strategy 6: useForm hook in memoizedState
    if (node.memoizedState) {
      let hook = node.memoizedState;
      while (hook) {
        if (hook.memoizedState && typeof hook.memoizedState === 'object') {
          // Check for form API structure
          if (hook.memoizedState.change && hook.memoizedState.submit && hook.memoizedState.batch) {
            this._forceLog(`✅ Found form API in hooks at depth ${depth}`);
            this._forceLog(`🔍 Hook form API methods:`, Object.keys(hook.memoizedState));
            return hook.memoizedState;
          }
          
          // Check for nested form API
          if (hook.memoizedState.form) {
            this._forceLog(`✅ Found nested form API in hooks at depth ${depth}`);
            return hook.memoizedState.form;
          }
        }
        hook = hook.next;
      }
    }
    
    // Strategy 7: Component type/name hints
    if (node.type) {
      const typeName = node.type.displayName || node.type.name || '';
      if (typeName.includes('Form') || typeName.includes('FinalForm')) {
        this._forceLog(`🎯 Found Form component "${typeName}" at depth ${depth}, checking props more thoroughly`);
        
        // Deep check all props for form API
        if (node.memoizedProps) {
          for (const [key, value] of Object.entries(node.memoizedProps)) {
            if (value && typeof value === 'object' && 
                'change' in value && 'submit' in value && 'batch' in value) {
              this._forceLog(`✅ Found form API in prop "${key}" of ${typeName} at depth ${depth}`);
              return value;
            }
          }
        }
      }
    }
    
    // Strategy 8: Check for finalFormInstanceHolder (from user's code)
    if (node.memoizedProps?.finalFormInstanceHolder) {
      this._forceLog(`🎯 Found finalFormInstanceHolder prop at depth ${depth}`);
      // This suggests React Final Form is being used, but API might be stored elsewhere
    }
    
    return null;
  }

  /**
   * Extract Formik API from React instance
   */
  private extractFormikApi(reactInstance: any): any {
    // Navigate React component tree to find Formik API
    let current = reactInstance;
    let depth = 0;
    const maxDepth = 15;
    
    while (current && depth < maxDepth) {
      if (current.memoizedProps?.formik) {
        return current.memoizedProps.formik;
      }
      
      if (current.stateNode?.setFieldValue) {
        return current.stateNode;
      }
      
      if (current.return) {
        current = current.return;
      } else if (current.child) {
        current = current.child;
      } else {
        break;
      }
      
      depth++;
    }
    
    return null;
  }

  /**
   * Set multiple field values at once
   */
  public setFormValues(formId: string, values: Record<string, any>): boolean {
    const form = this.forms.get(formId);
    if (!form) {
      this._forceLog(`❌ Form not found: ${formId}`);
      return false;
    }
    
    this._forceLog(`🚀 Setting multiple values in form ${formId}:`, Object.keys(values));
    
    let success = true;
    Object.entries(values).forEach(([fieldName, value]) => {
      if (!this.setFieldValue(formId, fieldName, value)) {
        success = false;
      }
    });
    
    this._forceLog(`📊 Bulk set result: ${success ? 'SUCCESS' : 'PARTIAL_FAILURE'}`);
    return success;
  }

  /**
   * Get all detected forms
   */
  public getForms(): EnhancedDetectedForm[] {
    return Array.from(this.forms.values());
  }

  /**
   * Get a specific form by ID
   */
  public getForm(formId: string): EnhancedDetectedForm | undefined {
    return this.forms.get(formId);
  }

  /**
   * Find best form match for given field names
   */
  public findBestFormMatch(fieldNames: string[]): EnhancedDetectedForm | null {
    let bestMatch: { form: EnhancedDetectedForm; score: number } | null = null;
    
    for (const form of this.forms.values()) {
      let score = 0;
      
      for (const fieldName of fieldNames) {
        if (form.fields.has(fieldName)) {
          score++;
        }
      }
      
      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { form, score };
      }
    }
    
    if (bestMatch) {
      this._forceLog(`✅ Best form match: ${bestMatch.form.id} (score: ${bestMatch.score}/${fieldNames.length})`);
      return bestMatch.form;
    }
    
    this._forceLog(`❌ No suitable form match found for fields: ${fieldNames.join(', ')}`);
    return null;
  }

  /**
   * Fill any suitable form with the provided field values
   */
  public fillAnyForm(fields: Record<string, string>): boolean {
    this._forceLog(`🎯 Enhanced fillAnyForm called with ${Object.keys(fields).length} fields`);
    
    // Re-detect forms to ensure we have the latest
    this.detectAllForms();
    
    const fieldNames = Object.keys(fields);
    const bestForm = this.findBestFormMatch(fieldNames);
    
    if (!bestForm) {
      this._forceLog(`❌ No suitable form found for fields: ${fieldNames.join(', ')}`);
      return false;
    }
    
    this._forceLog(`🚀 Using form ${bestForm.id} (${bestForm.formLibrary}) for filling`);
    return this.setFormValues(bestForm.id, fields);
  }

  /**
   * Reset form to initial values
   */
  public resetFormToInitialValues(formId: string): boolean {
    const form = this.forms.get(formId);
    if (!form) {
      this._forceLog(`❌ Form not found: ${formId}`);
      return false;
    }

    this._forceLog(`🔄 Resetting form ${formId} to initial values`);
    let success = true;
    
    form.fields.forEach((field, fieldName) => {
      if (!this.setFieldValue(formId, fieldName, field.initialValue)) {
        success = false;
      }
    });

    this._forceLog(`📊 Reset result: ${success ? 'SUCCESS' : 'PARTIAL_FAILURE'}`);
    return success;
  }

  /**
   * Get initial values for a specific form
   */
  public getFormInitialValues(formId: string): Record<string, any> | null {
    const form = this.forms.get(formId);
    if (!form) {
      this._forceLog(`❌ Form not found: ${formId}`);
      return null;
    }

    const initialValues: Record<string, any> = {};
    form.fields.forEach((field, fieldName) => {
      initialValues[fieldName] = field.initialValue;
    });

    return initialValues;
  }

  /**
   * Get initial values for all forms
   */
  public getAllFormsInitialValues(): Record<string, Record<string, any>> {
    const allInitialValues: Record<string, Record<string, any>> = {};

    this.forms.forEach((form, formId) => {
      const formInitialValues: Record<string, any> = {};
      form.fields.forEach((field, fieldName) => {
        formInitialValues[fieldName] = field.initialValue;
      });
      allInitialValues[formId] = formInitialValues;
    });

    return allInitialValues;
  }

  /**
   * Refresh form values (re-read current values from DOM)
   */
  public refreshFormValues(formId: string): boolean {
    const form = this.forms.get(formId);
    if (!form) {
      this._forceLog(`❌ Form not found: ${formId}`);
      return false;
    }

    form.fields.forEach((field, _fieldName) => {
      const element = field.element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

      // Update current value based on element type
      if (field.type === 'checkbox') {
        field.value = (element as HTMLInputElement).checked;
      } else if (field.type === 'radio') {
        field.value = (element as HTMLInputElement).checked ? element.value : '';
      } else if (field.type === 'select-multiple') {
        const select = element as HTMLSelectElement;
        field.value = Array.from(select.selectedOptions).map(option => option.value);
      } else if (field.type === 'selectbox' && element.tagName === 'BUTTON') {
        field.value = element.getAttribute('data-value') || '';
      } else {
        field.value = element.value || '';
      }
    });

    this._forceLog(`✅ Refreshed values for form ${formId}`);
    return true;
  }

  /**
   * Check if form has been modified from initial values
   */
  public isFormModified(formId: string): boolean {
    const form = this.forms.get(formId);
    if (!form) {
      this._forceLog(`❌ Form not found: ${formId}`);
      return false;
    }

    // Refresh current values before comparing
    this.refreshFormValues(formId);

    for (const [_fieldName, field] of form.fields) {
      if (JSON.stringify(field.value) !== JSON.stringify(field.initialValue)) {
        this._forceLog(`🔍 Form ${formId} is modified - field ${field.name}: current=${JSON.stringify(field.value)}, initial=${JSON.stringify(field.initialValue)}`);
        return true;
      }
    }

    this._forceLog(`✅ Form ${formId} is not modified`);
    return false;
  }

  /**
   * Get modified fields (fields that differ from initial values)
   */
  public getModifiedFields(formId: string): Record<string, { currentValue: any; initialValue: any }> {
    const form = this.forms.get(formId);
    if (!form) {
      this._forceLog(`❌ Form not found: ${formId}`);
      return {};
    }

    // Refresh current values before comparing
    this.refreshFormValues(formId);

    const modifiedFields: Record<string, { currentValue: any; initialValue: any }> = {};

    form.fields.forEach((field, fieldName) => {
      if (JSON.stringify(field.value) !== JSON.stringify(field.initialValue)) {
        modifiedFields[fieldName] = {
          currentValue: field.value,
          initialValue: field.initialValue,
        };
      }
    });

    this._forceLog(`📊 Found ${Object.keys(modifiedFields).length} modified fields in form ${formId}`);
    return modifiedFields;
  }

  /**
   * Clear all field values in a form
   */
  public clearForm(formId: string): boolean {
    const form = this.forms.get(formId);
    if (!form) {
      this._forceLog(`❌ Form not found: ${formId}`);
      return false;
    }

    this._forceLog(`🧹 Clearing all values in form ${formId}`);
    let success = true;
    
    form.fields.forEach((field, fieldName) => {
      const clearValue = field.type === 'checkbox' ? false : '';
      if (!this.setFieldValue(formId, fieldName, clearValue)) {
        success = false;
      }
    });

    this._forceLog(`📊 Clear result: ${success ? 'SUCCESS' : 'PARTIAL_FAILURE'}`);
    return success;
  }

  /**
   * Get form context in the format expected by the user
   */
  public getFormContext(formId: string): any | null {
    const form = this.forms.get(formId);
    if (!form) {
      this._forceLog(`❌ Form not found: ${formId}`);
      return null;
    }

    // Refresh values to get current state
    this.refreshFormValues(formId);

    const fields = Array.from(form.fields.values()).map(field => ({
      name: field.name,
      type: field.type,
      value: field.value,
      initialValue: field.initialValue,
      label: field.label,
      placeholder: field.placeholder,
      required: field.required,
      disabled: field.disabled,
      formLibrary: field.formLibrary,
    }));

    return {
      formId: form.id,
      formLibrary: form.formLibrary,
      fields,
    };
  }

  /**
   * Get all form contexts with initial values
   */
  public getAllFormContexts(): any[] {
    return Array.from(this.forms.values()).map(form => {
      // Refresh values to get current state
      this.refreshFormValues(form.id);
      
      return {
        formId: form.id,
        formLibrary: form.formLibrary,
        fields: Array.from(form.fields.values()).map(field => ({
          name: field.name,
          type: field.type,
          value: field.value,
          initialValue: field.initialValue,
          label: field.label,
          placeholder: field.placeholder,
          required: field.required,
          disabled: field.disabled,
          formLibrary: field.formLibrary,
        })),
      };
    });
  }

  /**
   * Dispose of the detector and clean up resources
   */
  public dispose(): void {
    this.forms.clear();
    this._forceLog('🧹 Enhanced Form Detector disposed');
  }
}
