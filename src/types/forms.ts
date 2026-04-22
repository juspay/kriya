export type FormFieldValueType = 'string' | 'number' | 'boolean' | 'array' | 'file';

export type FormFieldValue = {
  readonly type: FormFieldValueType;
  readonly value: string | number | boolean | readonly string[] | File;
};

export type FormFillResult = {
  readonly success: boolean;
  readonly fieldsCount: number;
  readonly filledFields: readonly string[];
  readonly failedFields: readonly string[];
  readonly error?: string;
  readonly formId?: string;
};

export type FormState = {
  readonly values: Record<string, unknown>;
  readonly errors: Record<string, string>;
  readonly touched: Record<string, boolean>;
  readonly valid: boolean;
  readonly submitting: boolean;
  readonly pristine: boolean;
};

export type FormAPI = {
  readonly change: (field: string, value: unknown) => void;
  readonly submit: () => Promise<void>;
  readonly getValues: () => Record<string, unknown>;
  readonly getState: () => FormState;
  readonly batch: (updates: () => void) => void;
  readonly reset: () => void;
  readonly initialize?: (values: Record<string, unknown>) => void;
};

export type FormFieldContext = {
  name: string;
  type: string;
  value: FormFieldValue;
  initialValue: FormFieldValue;
  placeholder?: string;
  required: boolean;
  disabled: boolean;
  label?: string;
};

export type FormContext = {
  readonly formId: string;
  readonly action?: string;
  readonly method: string;
  readonly fields: readonly FormFieldContext[];
  readonly isRegistered: boolean;
  readonly hasSubmitButton: boolean;
};

export type FormRegistryConfig = {
  readonly autoDetect: boolean;
  readonly maxForms: number;
  readonly includeHiddenFields: boolean;
  readonly trackFormChanges: boolean;
};

export type FormLibrary = {
  readonly name: string;
  readonly version: string;
  readonly detectForms: () => readonly HTMLFormElement[];
  readonly getFormAPI: (form: HTMLFormElement) => FormAPI | null;
  readonly isCompatible: (form: HTMLFormElement) => boolean;
};

export const DEFAULT_FORM_REGISTRY_CONFIG: FormRegistryConfig = {
  autoDetect: true,
  maxForms: 50,
  includeHiddenFields: false,
  trackFormChanges: true,
} as const;

/**
 * Loose handle for a detected form API (react-final-form / formik / native).
 * Shapes vary across libraries; callers narrow via typeof/in checks.
 */
export type DetectedFormApi = Record<string, unknown> & {
  change?: (field: string, value: unknown) => void;
  submit?: () => unknown;
  getState?: () => Record<string, unknown>;
  batch?: (fn: () => void) => void;
  reset?: () => void;
  initialize?: (values: Record<string, unknown>) => void;
  setFieldValue?: (field: string, value: unknown) => void;
  getRegisteredFields?: () => readonly string[];
};

export type EnhancedFormField = {
  element: HTMLElement;
  elements?: HTMLElement[];
  name: string;
  type: string;
  value: string | boolean | string[];
  initialValue: string | boolean | string[];
  label?: string;
  placeholder?: string;
  required: boolean;
  disabled: boolean;
  formLibrary?: 'react-final-form' | 'formik' | 'native' | 'unknown';
};

export type EnhancedDetectedForm = {
  element: HTMLFormElement | HTMLElement;
  id: string;
  name?: string;
  fields: Map<string, EnhancedFormField>;
  formLibrary: 'react-final-form' | 'formik' | 'native' | 'unknown';
  formApi?: DetectedFormApi;
};

export type EnhancedFormDetectorConfig = {
  autoDetect?: boolean;
  includeDisabled?: boolean;
  debugMode?: boolean;
  onFormDetected?: (form: EnhancedDetectedForm) => void;
  onFieldChanged?: (fieldName: string, value: unknown, form: EnhancedDetectedForm) => void;
};
