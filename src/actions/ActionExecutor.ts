import type {
  ActionCommand,
  AutomationConfig,
  ClickOptions,
  EventCallback,
  EventType,
  ExecutionResult,
  FillOptions,
  NavigationOptions,
  PressOptions,
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
  public addEventListener:
    | ((_eventType: EventType, _callback: EventCallback) => void)
    | null;

  constructor(config: AutomationConfig) {
    this._config = config;
    this._domActions = new DOMActions(config);
    this._formRegistry = null;
    this._contextCapture = null;
    this.addEventListener = null;
  }

  public initialize(
    formRegistry: FormRegistry,
    contextCapture: ContextCapture
  ): void {
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
        } catch (_screenshotError) {
          // Silently ignore screenshot errors
        }
      }

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';
      const errorCode =
        error instanceof AutomationError ? error.code : 'EXECUTION_FAILED';

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

  private async _executeActionInternal(
    action: ActionCommand
  ): Promise<unknown> {
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
        case 'press':
          return this._executePress(action);
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
    const options: ClickOptions = {
      selector: action.parameters.selector,
      description: action.parameters.description ?? action.description,
      button: (action.parameters.button as ClickOptions['button']) ?? 'left',
      clickCount: parseInt(action.parameters.clickCount ?? '1', 10),
    };

    if (action.parameters.x && action.parameters.y) {
      (
        options as ClickOptions & { position?: { x: number; y: number } }
      ).position = {
        x: parseInt(action.parameters.x, 10),
        y: parseInt(action.parameters.y, 10),
      };
    }

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

    const options: FillOptions = {
      selector: action.parameters.selector,
      description: action.parameters.description ?? action.description,
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
    // Two supported payload shapes:
    //   1. Nested envelope: { fields: { fieldA: ..., fieldB: ... } }
    //   2. Flat: { fieldA: ..., fieldB: ... } — each top-level key (minus
    //      reserved names like formId/fields/values) is a form field name
    //      and its value is the field value. This matches how users commonly
    //      author payloads where a form has a top-level field named "json"
    //      that holds the real state tree.
    const params = action.parameters as Record<string, unknown>;
    const RESERVED = new Set(['formId', 'fields', 'values']);
    let fieldsParam: unknown = params.fields ?? params.values;
    if (fieldsParam === undefined) {
      const flat: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(params)) {
        if (!RESERVED.has(k)) flat[k] = v;
      }
      if (Object.keys(flat).length > 0) fieldsParam = flat;
    }

    if (!fieldsParam) {
      throw new AutomationError(
        'FillForm action requires fields (either a `fields`/`values` object or top-level field entries in `parameters`)',
        'VALIDATION_FAILED',
        { action }
      );
    }

    // Allow any value type, not just strings - supports arrays, objects, etc.
    let fields: Record<string, unknown>;
    try {
      fields =
        typeof fieldsParam === 'string' ? JSON.parse(fieldsParam) : fieldsParam;
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

  private async _executePress(action: ActionCommand): Promise<void> {
    const key = action.parameters.key;
    if (!key) {
      throw new AutomationError(
        'Press action requires key parameter',
        'VALIDATION_FAILED',
        { action }
      );
    }

    const options: PressOptions = {
      key,
      selector: action.parameters.selector,
      description: action.parameters.description,
    };

    return this._domActions.press(options);
  }

  private async _withTimeout<T>(
    operation: () => Promise<T>,
    timeout: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(
          new AutomationError(
            `Operation timed out after ${timeout}ms`,
            'EXECUTION_TIMEOUT'
          )
        );
      }, timeout);

      operation()
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }
}
