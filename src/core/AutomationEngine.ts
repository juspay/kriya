import type {
  ActionCommand,
  AutomationConfig,
  AutomationEvent,
  EventCallback,
  EventType,
  ExecutionEffect,
  ExecutionOptions,
  ExecutionResult,
  FormLibrary,
  PageContext,
} from '@/types';
import { ACTION_TYPES, DEFAULT_CONFIG } from '@/types';
import { AutomationError } from '@/types';
import { ActionExecutor } from '@/actions/ActionExecutor';
import {
  isStrictExecution,
  redactActionParameters,
  scrubActionData,
  scrubActionTextSafely,
  validateActionParameters,
} from '@/actions/parameters';
import { ContextCapture } from '@/context/ContextCapture';
import { FormRegistry } from '@/forms/FormRegistry';

// Event payloads carry results to third parties; a data URL is too large to scan and holds no typed text.
const MAX_SCRUBBED_STRING_CHARS = 20000;

export class AutomationEngine {
  private readonly _config: AutomationConfig;
  private readonly _actionExecutor: ActionExecutor;
  private readonly _contextCapture: ContextCapture;
  private readonly _formRegistry: FormRegistry;
  private readonly _eventListeners: Map<EventType, Set<EventCallback>>;
  private _initialized: boolean;

  constructor(config: Partial<AutomationConfig> = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._eventListeners = new Map();
    this._initialized = false;

    this._actionExecutor = new ActionExecutor(this._config);
    this._contextCapture = new ContextCapture(this._config);
    this._formRegistry = new FormRegistry(this._config);

    this._setupEventHandlers();
  }

  public initialize(formLibrary?: FormLibrary): void {
    if (this._initialized) {
      throw new AutomationError('AutomationEngine is already initialized', 'INVALID_CONFIGURATION');
    }

    try {
      this._contextCapture.initialize();
      this._formRegistry.initialize(formLibrary);
      this._actionExecutor.initialize(this._formRegistry, this._contextCapture);

      this._initialized = true;
      this._emitEvent('action_started', { action: 'initialize' });
    } catch (error) {
      throw new AutomationError(
        `Failed to initialize AutomationEngine: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'INVALID_CONFIGURATION',
        { originalError: error }
      );
    }
  }

  public async executeAction(
    action: ActionCommand,
    options?: ExecutionOptions
  ): Promise<ExecutionResult> {
    this._ensureInitialized();

    if (options?.signal?.aborted === true) {
      return this._failedResult('Operation was cancelled', 'EXECUTION_CANCELLED', 'none');
    }

    const invalid = this._validateAction(action, options);
    if (invalid) {
      return invalid;
    }

    this._emitEvent('action_started', {
      action: action.type,
      parameters: this._describeParameters(action),
    });

    let result: ExecutionResult;
    try {
      result = await this._actionExecutor.executeAction(action, options);
    } catch (error) {
      // The executor reports every outcome as a result; an escape means its own state is unknown.
      result = this._failedResult(
        scrubActionTextSafely(
          error instanceof Error ? error.message : 'Unknown error',
          action,
          this._config.redactor
        ),
        error instanceof AutomationError ? error.code : 'EXECUTION_FAILED',
        'uncertain'
      );
    }

    // The action has already run: nothing that goes wrong while telling listeners may change what the caller sees.
    try {
      this._publishResult(action, result);
    } catch {
      // A faulty redactor withholds the event instead of leaking it or rejecting a committed action.
    }
    return result;
  }

  public async executeActions(
    actions: readonly ActionCommand[]
  ): Promise<readonly ExecutionResult[]> {
    this._ensureInitialized();

    if (actions.length === 0) {
      return [];
    }

    const results: ExecutionResult[] = [];

    for (const action of actions) {
      const result = await this.executeAction(action);
      results.push(result);

      if (!result.success && this._config.debugMode) {
        break;
      }
    }

    return results;
  }

  public async capturePageContext(): Promise<PageContext> {
    this._ensureInitialized();

    try {
      const context = await this._contextCapture.capturePageContext();
      this._emitEvent('context_captured', {
        formsFound: context.totalFormsFound,
        elementsFound: context.elements.length,
      });
      return context;
    } catch (error) {
      throw new AutomationError(
        `Failed to capture page context: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'EXECUTION_FAILED',
        { originalError: error }
      );
    }
  }

  public registerForm(formId: string, formElement: HTMLFormElement): void {
    this._ensureInitialized();
    this._formRegistry.registerForm(formId, formElement);
    this._emitEvent('form_registered', {
      formId,
      formElement: formElement.tagName,
    });
  }

  public unregisterForm(formId: string): void {
    this._ensureInitialized();
    this._formRegistry.unregisterForm(formId);
    this._emitEvent('form_unregistered', { formId });
  }

  public addEventListener(eventType: EventType, callback: EventCallback): void {
    let listeners = this._eventListeners.get(eventType);
    if (!listeners) {
      listeners = new Set();
      this._eventListeners.set(eventType, listeners);
    }
    listeners.add(callback);
  }

  public removeEventListener(eventType: EventType, callback: EventCallback): void {
    const listeners = this._eventListeners.get(eventType);
    if (listeners) {
      listeners.delete(callback);
    }
  }

  public getConfig(): Readonly<AutomationConfig> {
    return { ...this._config };
  }

  public isInitialized(): boolean {
    return this._initialized;
  }

  public dispose(): void {
    if (!this._initialized) {
      return;
    }

    this._actionExecutor.dispose();
    this._contextCapture.dispose();
    this._formRegistry.dispose();
    this._eventListeners.clear();
    this._initialized = false;
  }

  private _ensureInitialized(): void {
    if (!this._initialized) {
      throw new AutomationError(
        'AutomationEngine must be initialized before use',
        'INVALID_CONFIGURATION'
      );
    }
  }

  private _failedResult(
    error: string,
    errorCode: ExecutionResult['errorCode'],
    effect: ExecutionEffect
  ): ExecutionResult {
    return {
      success: false,
      status: 'failed',
      error,
      errorCode,
      timestamp: Date.now(),
      effect,
    };
  }

  // Invalid input is a failed result, not a rejection, and never repeats a parameter value.
  private _validateAction(
    action: ActionCommand,
    options?: ExecutionOptions
  ): ExecutionResult | null {
    if (!action || !action.type || typeof action.type !== 'string') {
      return this._failedResult(
        'Action type is required and must be a string',
        'VALIDATION_FAILED',
        'none'
      );
    }

    if (!action.parameters || typeof action.parameters !== 'object') {
      return this._failedResult(
        'Action parameters are required and must be an object',
        'VALIDATION_FAILED',
        'none'
      );
    }

    if (!ACTION_TYPES.includes(action.type)) {
      return this._failedResult(
        `Invalid action type. Valid types: ${ACTION_TYPES.join(', ')}`,
        'VALIDATION_FAILED',
        'none'
      );
    }

    const issue = validateActionParameters(action, isStrictExecution(action, options));
    return issue ? this._failedResult(issue.message, issue.code, 'none') : null;
  }

  private _describeParameters(action: ActionCommand): Readonly<Record<string, string>> {
    try {
      return redactActionParameters(action, this._config.redactor);
    } catch {
      return {};
    }
  }

  private _publishResult(action: ActionCommand, result: ExecutionResult): void {
    if (result.success) {
      this._emitEvent('action_completed', {
        action: action.type,
        result: this._scrubData(action, result.data),
        effect: result.effect,
      });
    } else {
      this._emitEvent('action_failed', {
        action: action.type,
        error:
          result.error === undefined
            ? undefined
            : scrubActionTextSafely(result.error, action, this._config.redactor),
        errorCode: result.errorCode,
        effect: result.effect,
      });
    }
  }

  private _scrubData(action: ActionCommand, data: unknown): unknown {
    const redactor = this._config.redactor;
    if (typeof data === 'string') {
      return data.length > MAX_SCRUBBED_STRING_CHARS
        ? data
        : scrubActionTextSafely(data, action, redactor);
    }
    if (data === null || typeof data !== 'object') {
      return data;
    }
    try {
      return scrubActionData(data, action, redactor);
    } catch {
      return undefined;
    }
  }

  private _setupEventHandlers(): void {
    this._actionExecutor.addEventListener = (
      eventType: EventType,
      callback: EventCallback
    ): void => {
      this.addEventListener(eventType, callback);
    };

    this._contextCapture.addEventListener = (
      eventType: EventType,
      callback: EventCallback
    ): void => {
      this.addEventListener(eventType, callback);
    };

    this._formRegistry.addEventListener = (eventType: EventType, callback: EventCallback): void => {
      this.addEventListener(eventType, callback);
    };
  }

  // A listener is third-party code: whatever it does, it can never change or abort an action result.
  private _emitEvent(eventType: EventType, data?: Readonly<Record<string, unknown>>): void {
    const event: AutomationEvent = {
      type: eventType,
      timestamp: Date.now(),
      data,
    };

    const listeners = this._eventListeners.get(eventType);
    if (listeners) {
      [...listeners].forEach(callback => {
        try {
          callback(event);
        } catch {
          // Deliberately swallowed, in debugMode too (G13).
        }
      });
    }
  }
}
