import { AutomationEngine } from '@/core/AutomationEngine';
import { AutomationError } from '@/types';

export { AutomationEngine } from '@/core/AutomationEngine';
export { ActionExecutor } from '@/actions/ActionExecutor';
export { DOMActions } from '@/actions/DOMActions';
export { FormRegistry } from '@/forms/FormRegistry';
export { ContextCapture } from '@/context/ContextCapture';

export type {
  ActionCommand,
  ActionType,
  AutomationConfig,
  AutomationEvent,
  ClickOptions,
  ContextCaptureConfig,
  ElementContext,
  ErrorCode,
  EventCallback,
  EventType,
  ExecutionResult,
  FillOptions,
  FormAPI,
  FormContext,
  FormFieldContext,
  FormFieldValue,
  FormFieldValueType,
  FormFillResult,
  FormLibrary,
  FormRegistryConfig,
  FormState,
  NavigationOptions,
  PageContext,
  ScreenshotOptions,
  ViewportInfo,
  WaitOptions,
} from '@/types';

export { AutomationError, DEFAULT_CONFIG } from '@/types';

export interface WebAutomataAPI {
  initialize(formLibrary?: import('@/types').FormLibrary): void;
  executeAction(action: import('@/types').ActionCommand): Promise<import('@/types').ExecutionResult>;
  executeActions(actions: readonly import('@/types').ActionCommand[]): Promise<readonly import('@/types').ExecutionResult[]>;
  capturePageContext(): Promise<import('@/types').PageContext>;
  registerForm(formId: string, formElement: HTMLFormElement): void;
  unregisterForm(formId: string): void;
  addEventListener(eventType: import('@/types').EventType, callback: import('@/types').EventCallback): void;
  removeEventListener(eventType: import('@/types').EventType, callback: import('@/types').EventCallback): void;
  captureScreenshot(options?: Partial<import('@/types').ScreenshotOptions>): Promise<string>;
  isInitialized(): boolean;
  dispose(): void;
}

export function createAutomationEngine(config?: Partial<import('@/types').AutomationConfig>): WebAutomataAPI {
  const engine = new AutomationEngine(config);

  return {
    initialize: (formLibrary?: import('@/types').FormLibrary): void => {
      engine.initialize(formLibrary);
    },

    executeAction: async (action: import('@/types').ActionCommand): Promise<import('@/types').ExecutionResult> => {
      return engine.executeAction(action);
    },

    executeActions: async (actions: readonly import('@/types').ActionCommand[]): Promise<readonly import('@/types').ExecutionResult[]> => {
      return engine.executeActions(actions);
    },

    capturePageContext: async (): Promise<import('@/types').PageContext> => {
      return engine.capturePageContext();
    },

    registerForm: (formId: string, formElement: HTMLFormElement): void => {
      engine.registerForm(formId, formElement);
    },

    unregisterForm: (formId: string): void => {
      engine.unregisterForm(formId);
    },

    addEventListener: (eventType: import('@/types').EventType, callback: import('@/types').EventCallback): void => {
      engine.addEventListener(eventType, callback);
    },

    removeEventListener: (eventType: import('@/types').EventType, callback: import('@/types').EventCallback): void => {
      engine.removeEventListener(eventType, callback);
    },

    captureScreenshot: async (options?: Partial<import('@/types').ScreenshotOptions>): Promise<string> => {
      const context = (engine as any)._contextCapture;
      if (!context) {
        throw new AutomationError('ContextCapture not initialized', 'INVALID_CONFIGURATION');
      }
      return context.captureScreenshot(options);
    },

    isInitialized: (): boolean => {
      return engine.isInitialized();
    },

    dispose: (): void => {
      engine.dispose();
    },
  };
}

export default createAutomationEngine;