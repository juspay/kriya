import type { ActionCommand, ExecutionResult } from './actions';
import type { PageContext, ScreenshotOptions } from './context';
import type { EventCallback, EventType } from './events';
import type { FormLibrary } from './forms';

export type AutomationConfig = {
  readonly timeout: number;
  readonly retryAttempts: number;
  readonly screenshotOnError: boolean;
  readonly debugMode: boolean;
  readonly formDetectionEnabled: boolean;
  readonly contextCaptureEnabled: boolean;
};

export const DEFAULT_CONFIG: AutomationConfig = {
  timeout: 5000,
  retryAttempts: 3,
  screenshotOnError: true,
  debugMode: false,
  formDetectionEnabled: true,
  contextCaptureEnabled: true,
} as const;

export type WebAutomataAPI = {
  initialize: (formLibrary?: FormLibrary) => void;
  executeAction: (action: ActionCommand) => Promise<ExecutionResult>;
  executeActions: (actions: readonly ActionCommand[]) => Promise<readonly ExecutionResult[]>;
  capturePageContext: () => Promise<PageContext>;
  registerForm: (formId: string, formElement: HTMLFormElement) => void;
  unregisterForm: (formId: string) => void;
  addEventListener: (eventType: EventType, callback: EventCallback) => void;
  removeEventListener: (eventType: EventType, callback: EventCallback) => void;
  captureScreenshot: (options?: Partial<ScreenshotOptions>) => Promise<string>;
  isInitialized: () => boolean;
  dispose: () => void;
};
