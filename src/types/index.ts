export type ActionType = 
  | 'navigate'
  | 'click' 
  | 'fill'
  | 'fillForm'
  | 'submitForm'
  | 'screenshot'
  | 'wait';

export interface ActionCommand {
  readonly type: ActionType;
  readonly parameters: Readonly<Record<string, string>>;
  readonly timeout?: number;
  readonly description?: string;
}

export type FormFieldValueType = 'string' | 'number' | 'boolean' | 'array' | 'file';

export interface FormFieldValue {
  readonly type: FormFieldValueType;
  readonly value: string | number | boolean | readonly string[] | File;
}

export type ExecutionStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ExecutionResult {
  readonly success: boolean;
  readonly status: ExecutionStatus;
  readonly data?: unknown;
  readonly error?: string;
  readonly errorCode?: ErrorCode;
  readonly timestamp: number;
}

export interface FormFillResult {
  readonly success: boolean;
  readonly fieldsCount: number;
  readonly filledFields: readonly string[];
  readonly failedFields: readonly string[];
  readonly error?: string;
  readonly formId?: string;
}

export interface FormAPI {
  readonly change: (field: string, value: unknown) => void;
  readonly submit: () => Promise<void>;
  readonly getValues: () => Record<string, unknown>;
  readonly getState: () => FormState;
  readonly batch: (updates: () => void) => void;
  readonly reset: () => void;
}

export interface FormState {
  readonly values: Record<string, unknown>;
  readonly errors: Record<string, string>;
  readonly touched: Record<string, boolean>;
  readonly valid: boolean;
  readonly submitting: boolean;
  readonly pristine: boolean;
}

export interface PageContext {
  readonly pageUrl: string;
  readonly title: string;
  readonly timestamp: number;
  readonly totalFormsFound: number;
  readonly forms: readonly FormContext[];
  readonly elements: readonly ElementContext[];
  readonly viewport: ViewportInfo;
}

export interface FormContext {
  readonly formId: string;
  readonly action?: string;
  readonly method: string;
  readonly fields: readonly FormFieldContext[];
  readonly isRegistered: boolean;
  readonly hasSubmitButton: boolean;
}

export interface FormFieldContext {
  readonly name: string;
  readonly type: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly required: boolean;
  readonly disabled: boolean;
  readonly label?: string;
  readonly options?: readonly string[];
  readonly multiselect?: boolean;
}

export interface ElementContext {
  readonly tagName: string;
  readonly id?: string;
  readonly className?: string;
  readonly textContent?: string;
  readonly type?: string;
  readonly value?: string;
  readonly href?: string;
  readonly clickable: boolean;
  readonly visible: boolean;
}

export interface ViewportInfo {
  readonly width: number;
  readonly height: number;
  readonly scrollX: number;
  readonly scrollY: number;
}

export interface ScreenshotOptions {
  readonly fullPage: boolean;
  readonly quality: number;
  readonly format: 'png' | 'jpeg' | 'webp';
  readonly clip?: ClipRegion;
}

export interface ClipRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AutomationConfig {
  readonly timeout: number;
  readonly retryAttempts: number;
  readonly screenshotOnError: boolean;
  readonly debugMode: boolean;
  readonly formDetectionEnabled: boolean;
  readonly contextCaptureEnabled: boolean;
}

export interface FormRegistryConfig {
  readonly autoDetect: boolean;
  readonly maxForms: number;
  readonly includeHiddenFields: boolean;
  readonly trackFormChanges: boolean;
}

export interface ContextCaptureConfig {
  readonly includeScreenshot: boolean;
  readonly includeFormData: boolean;
  readonly includeElementData: boolean;
  readonly maxElementsPerPage: number;
}

export type ErrorCode =
  | 'INVALID_ACTION'
  | 'ELEMENT_NOT_FOUND'
  | 'FORM_NOT_REGISTERED'
  | 'FORM_NOT_FOUND'
  | 'FIELD_NOT_FOUND'
  | 'EXECUTION_TIMEOUT'
  | 'EXECUTION_FAILED'
  | 'NETWORK_ERROR'
  | 'PERMISSION_DENIED'
  | 'INVALID_CONFIGURATION'
  | 'SCREENSHOT_FAILED'
  | 'VALIDATION_FAILED'
  | 'BROWSER_NOT_SUPPORTED';

export class AutomationError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly context?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = 'AutomationError';
  }
}

export type EventType = 
  | 'form_registered'
  | 'form_unregistered'
  | 'form_filled'
  | 'form_submitted'
  | 'action_started'
  | 'action_completed'
  | 'action_failed'
  | 'context_captured'
  | 'screenshot_taken';

export interface AutomationEvent {
  readonly type: EventType;
  readonly timestamp: number;
  readonly data?: Readonly<Record<string, unknown>>;
}

export type EventCallback = (event: AutomationEvent) => void;

export interface FormLibrary {
  readonly name: string;
  readonly version: string;
  readonly detectForms: () => readonly HTMLFormElement[];
  readonly getFormAPI: (form: HTMLFormElement) => FormAPI | null;
  readonly isCompatible: (form: HTMLFormElement) => boolean;
}

export interface NavigationOptions {
  readonly url: string;
  readonly waitForLoad: boolean;
  readonly timeout?: number;
}

export interface ClickOptions {
  readonly selector?: string;
  readonly description?: string;
  readonly position?: { x: number; y: number };
  readonly button: 'left' | 'right' | 'middle';
  readonly clickCount: number;
}

export interface FillOptions {
  readonly selector?: string;
  readonly description?: string;
  readonly value: string;
  readonly clearFirst: boolean;
  readonly triggerEvents: boolean;
}

export interface WaitOptions {
  readonly duration?: number;
  readonly selector?: string;
  readonly condition?: 'visible' | 'hidden' | 'enabled' | 'disabled';
  readonly timeout?: number;
}

export const DEFAULT_CONFIG: AutomationConfig = {
  timeout: 5000,
  retryAttempts: 3,
  screenshotOnError: true,
  debugMode: false,
  formDetectionEnabled: true,
  contextCaptureEnabled: true,
} as const;

export const DEFAULT_FORM_REGISTRY_CONFIG: FormRegistryConfig = {
  autoDetect: true,
  maxForms: 50,
  includeHiddenFields: false,
  trackFormChanges: true,
} as const;

export const DEFAULT_CONTEXT_CAPTURE_CONFIG: ContextCaptureConfig = {
  includeScreenshot: true,
  includeFormData: true,
  includeElementData: true,
  maxElementsPerPage: 100,
} as const;
