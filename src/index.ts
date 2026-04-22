import { AutomationEngine } from '@/core/AutomationEngine';
import type {
  ActionCommand,
  AutomationConfig,
  EventCallback,
  EventType,
  ExecutionResult,
  FormLibrary,
  PageContext,
  ScreenshotOptions,
  WebAutomataAPI,
} from '@/types';
import { AutomationError } from '@/types';

export { AutomationEngine } from '@/core/AutomationEngine';
export { ActionExecutor } from '@/actions/ActionExecutor';
export { DOMActions } from '@/actions/DOMActions';
export { FormRegistry } from '@/forms/FormRegistry';
export { EnhancedFormDetector } from '@/forms/EnhancedFormDetector';
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
  NavigationOptions,
  PageContext,
  ScreenshotOptions,
  ViewportInfo,
  WaitOptions,
  WebAutomataAPI,
} from '@/types';

export { AutomationError, DEFAULT_CONFIG } from '@/types';

export function createAutomationEngine(config?: Partial<AutomationConfig>): WebAutomataAPI {
  const engine = new AutomationEngine(config);

  return {
    initialize: (formLibrary?: FormLibrary): void => {
      engine.initialize(formLibrary);
    },

    executeAction: async (action: ActionCommand): Promise<ExecutionResult> => {
      return engine.executeAction(action);
    },

    executeActions: async (
      actions: readonly ActionCommand[]
    ): Promise<readonly ExecutionResult[]> => {
      return engine.executeActions(actions);
    },

    capturePageContext: async (): Promise<PageContext> => {
      return engine.capturePageContext();
    },

    registerForm: (formId: string, formElement: HTMLFormElement): void => {
      engine.registerForm(formId, formElement);
    },

    unregisterForm: (formId: string): void => {
      engine.unregisterForm(formId);
    },

    addEventListener: (eventType: EventType, callback: EventCallback): void => {
      engine.addEventListener(eventType, callback);
    },

    removeEventListener: (eventType: EventType, callback: EventCallback): void => {
      engine.removeEventListener(eventType, callback);
    },

    captureScreenshot: async (options?: Partial<ScreenshotOptions>): Promise<string> => {
      const context = (
        engine as unknown as {
          _contextCapture?: {
            captureScreenshot: (_options?: Partial<ScreenshotOptions>) => Promise<string>;
          };
        }
      )._contextCapture;
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
