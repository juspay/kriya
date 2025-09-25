import type {
  ActionCommand,
  AutomationConfig,
  ClickOptions,
  EventCallback,
  EventType,
  ExecutionResult,
  FillOptions,
  NavigationOptions,
  WaitOptions,
} from '@/types';
import { AutomationError } from '@/types';
import type { ContextCapture } from '@/context/ContextCapture';
import type { FormRegistry } from '@/forms/FormRegistry';
import { DOMActions } from '@/actions/DOMActions';

export class ActionExecutor {
  private readonly _config: AutomationConfig;
  private readonly _domActions: DOMActions;
  private _formRegistry: FormRegistry | null;
  private _contextCapture: ContextCapture | null;
  public addEventListener: ((eventType: EventType, callback: EventCallback) => void) | null;

  constructor(config: AutomationConfig) {
    this._config = config;
    this._domActions = new DOMActions(config);
    this._formRegistry = null;
    this._contextCapture = null;
    this.addEventListener = null;
  }

  public initialize(formRegistry: FormRegistry, contextCapture: ContextCapture): void {
    this._formRegistry = formRegistry;
    this._contextCapture = contextCapture;
    this._domActions.initialize();
  }

  public async executeAction(action: ActionCommand): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      const result = await this._executeActionInternal(action);
      
      return {
        success: true,
        status: 'completed',
        data: result,
        timestamp: startTime,
      };
    } catch (error) {
      if (this._config.screenshotOnError && this._contextCapture) {
        try {
          await this._contextCapture.captureScreenshot();
        } catch (screenshotError) {
          // Silently ignore screenshot errors
        }
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      const errorCode = error instanceof AutomationError ? error.code : 'EXECUTION_FAILED';

      return {
        success: false,
        status: 'failed',
        error: errorMessage,
        errorCode,
        timestamp: startTime,
      };
    }
  }

  public dispose(): void {
    this._domActions.dispose();
    this._formRegistry = null;
    this._contextCapture = null;
    this.addEventListener = null;
  }

  private async _executeActionInternal(action: ActionCommand): Promise<unknown> {
    const timeout = action.timeout ?? this._config.timeout;

    return this._withTimeout(async () => {
      switch (action.type) {
        case 'navigate':
          return this._executeNavigate(action);
        case 'click':
          return this._executeClick(action);
        case 'fill':
          return this._executeFill(action);
        case 'fillForm':
          return this._executeFillForm(action);
        case 'submitForm':
          return this._executeSubmitForm(action);
        case 'screenshot':
          return this._executeScreenshot(action);
        case 'wait':
          return this._executeWait(action);
        default:
          throw new AutomationError(
            `Unsupported action type: ${action.type}`,
            'INVALID_ACTION',
            { action }
          );
      }
    }, timeout);
  }

  private async _executeNavigate(action: ActionCommand): Promise<void> {
    const url = action.parameters.url;
    if (!url) {
      throw new AutomationError(
        'Navigate action requires url parameter',
        'VALIDATION_FAILED',
        { action }
      );
    }

    const options: NavigationOptions = {
      url,
      waitForLoad: action.parameters.waitForLoad === 'true',
      timeout: action.timeout,
    };

    return this._domActions.navigate(options);
  }

  private async _executeClick(action: ActionCommand): Promise<void> {
    console.log('🎯 ActionExecutor._executeClick called with:', action.parameters);
    
    // Backward compatibility: accept `target` when `description` is absent
    const rawTarget = action.parameters.description 
      ?? action.description 
      ?? action.parameters.target;

    // If no explicit selector provided, but target looks like CSS, treat as selector
    let selector = action.parameters.selector;
    if (!selector && rawTarget && (rawTarget.includes('#') || rawTarget.includes('.') || rawTarget.includes('['))) {
      selector = rawTarget;
    }

    const options: ClickOptions = {
      selector,
      description: rawTarget,
      button: (action.parameters.button as ClickOptions['button']) ?? 'left',
      clickCount: parseInt(action.parameters.clickCount ?? '1', 10),
    };

    if (action.parameters.x && action.parameters.y) {
      (options as any).position = {
        x: parseInt(action.parameters.x, 10),
        y: parseInt(action.parameters.y, 10),
      };
    }

    console.log('🎯 ActionExecutor calling DOMActions.click with options:', options);
    return this._domActions.click(options);
  }

  private async _executeFill(action: ActionCommand): Promise<void> {
    const value = action.parameters.value;
    if (!value) {
      throw new AutomationError(
        'Fill action requires value parameter',
        'VALIDATION_FAILED',
        { action }
      );
    }

    // Backward compatibility: accept `target` when `description` is absent
    const rawTarget = action.parameters.description 
      ?? action.description 
      ?? action.parameters.target;

    // If no explicit selector provided, but target looks like CSS, treat as selector
    let selector = action.parameters.selector;
    if (!selector && rawTarget && (rawTarget.includes('#') || rawTarget.includes('.') || rawTarget.includes('['))) {
      selector = rawTarget;
    }

    const options: FillOptions = {
      selector,
      description: rawTarget,
      value,
      clearFirst: action.parameters.clearFirst === 'true',
      triggerEvents: action.parameters.triggerEvents !== 'false',
    };

    return this._domActions.fill(options);
  }

  private async _executeFillForm(action: ActionCommand): Promise<unknown> {
    if (!this._formRegistry) {
      throw new AutomationError(
        'Form registry not initialized',
        'INVALID_CONFIGURATION'
      );
    }

    const formId = action.parameters.formId;
    const fieldsParam = action.parameters.fields;

    if (!fieldsParam) {
      throw new AutomationError(
        'FillForm action requires fields parameter',
        'VALIDATION_FAILED',
        { action }
      );
    }

    let fields: Record<string, string>;
    try {
      fields = typeof fieldsParam === 'string' ? JSON.parse(fieldsParam) : fieldsParam;
    } catch (error) {
      throw new AutomationError(
        'Invalid fields parameter format',
        'VALIDATION_FAILED',
        { action, originalError: error }
      );
    }

    if (formId) {
      return this._formRegistry.fillForm(formId, fields);
    } else {
      return this._formRegistry.fillAnyForm(fields);
    }
  }

  private async _executeSubmitForm(action: ActionCommand): Promise<unknown> {
    if (!this._formRegistry) {
      throw new AutomationError(
        'Form registry not initialized',
        'INVALID_CONFIGURATION'
      );
    }

    const formId = action.parameters.formId;

    if (formId) {
      return this._formRegistry.submitForm(formId);
    } else {
      return this._formRegistry.submitAnyForm();
    }
  }

  private async _executeScreenshot(action: ActionCommand): Promise<string> {
    if (!this._contextCapture) {
      throw new AutomationError(
        'Context capture not initialized',
        'INVALID_CONFIGURATION'
      );
    }

    const fullPage = action.parameters.fullPage === 'true';
    const quality = parseFloat(action.parameters.quality ?? '0.9');

    return this._contextCapture.captureScreenshot({
      fullPage,
      quality,
      format: 'png',
    });
  }

  private async _executeWait(action: ActionCommand): Promise<void> {
    const options: WaitOptions = {
      duration: parseInt(action.parameters.duration ?? '1000', 10),
      selector: action.parameters.selector,
      condition: action.parameters.condition as WaitOptions['condition'],
      timeout: action.timeout,
    };

    return this._domActions.wait(options);
  }

  private async _withTimeout<T>(
    operation: () => Promise<T>, 
    timeout: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new AutomationError(
          `Operation timed out after ${timeout}ms`,
          'EXECUTION_TIMEOUT'
        ));
      }, timeout);

      operation()
        .then(result => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }
}
