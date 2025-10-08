import type {
  ActionCommand,
  AutomationConfig,
  AutomationEvent,
  ErrorCode,
  EventCallback,
  EventType,
  ExecutionResult,
  FormLibrary,
  PageContext,
} from '@/types';
import { DEFAULT_CONFIG } from '@/types';
import { AutomationError } from '@/types';
import { ActionExecutor } from '@/actions/ActionExecutor';
import { ContextCapture } from '@/context/ContextCapture';
import { FormRegistry } from '@/forms/FormRegistry';

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
      throw new AutomationError(
        'AutomationEngine is already initialized',
        'INVALID_CONFIGURATION'
      );
    }

    try {
      this._contextCapture.initialize();
      this._formRegistry.initialize(formLibrary);
      
      // Connect FormRegistry to ContextCapture for proper form detection
      this._contextCapture.setFormRegistry(this._formRegistry);
      
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

  public async executeAction(action: ActionCommand): Promise<ExecutionResult> {
    this._ensureInitialized();
    this._validateAction(action);

    this._emitEvent('action_started', { action: action.type, parameters: action.parameters });

    try {
      const result = await this._actionExecutor.executeAction(action);
      
      if (result.success) {
        this._emitEvent('action_completed', { 
          action: action.type, 
          result: result.data 
        });
      } else {
        this._emitEvent('action_failed', { 
          action: action.type, 
          error: result.error 
        });
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this._emitEvent('action_failed', { 
        action: action.type, 
        error: errorMessage 
      });

      return {
        success: false,
        status: 'failed',
        error: errorMessage,
        errorCode: error instanceof AutomationError ? error.code : 'EXECUTION_FAILED',
        timestamp: Date.now(),
      };
    }
  }

  public async executeActions(actions: readonly ActionCommand[]): Promise<readonly ExecutionResult[]> {
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
        elementsFound: context.elements.length 
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
    this._emitEvent('form_registered', { formId, formElement: formElement.tagName });
  }

  public unregisterForm(formId: string): void {
    this._ensureInitialized();
    this._formRegistry.unregisterForm(formId);
    this._emitEvent('form_unregistered', { formId });
  }

  public addEventListener(eventType: EventType, callback: EventCallback): void {
    if (!this._eventListeners.has(eventType)) {
      this._eventListeners.set(eventType, new Set());
    }
    this._eventListeners.get(eventType)!.add(callback);
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

  private _validateAction(action: ActionCommand): void {
    if (!action.type || typeof action.type !== 'string') {
      throw new AutomationError(
        'Action type is required and must be a string',
        'VALIDATION_FAILED',
        { action }
      );
    }

    if (!action.parameters || typeof action.parameters !== 'object') {
      throw new AutomationError(
        'Action parameters are required and must be an object',
        'VALIDATION_FAILED',
        { action }
      );
    }

    const validActionTypes = ['navigate', 'click', 'fill', 'fillForm', 'submitForm', 'screenshot', 'wait'];
    if (!validActionTypes.includes(action.type)) {
      throw new AutomationError(
        `Invalid action type: ${action.type}. Valid types: ${validActionTypes.join(', ')}`,
        'VALIDATION_FAILED',
        { action, validTypes: validActionTypes }
      );
    }
  }

  private _setupEventHandlers(): void {
    this._actionExecutor.addEventListener = (eventType: EventType, callback: EventCallback): void => {
      this.addEventListener(eventType, callback);
    };

    this._contextCapture.addEventListener = (eventType: EventType, callback: EventCallback): void => {
      this.addEventListener(eventType, callback);
    };

    this._formRegistry.addEventListener = (eventType: EventType, callback: EventCallback): void => {
      this.addEventListener(eventType, callback);
    };
  }

  private _emitEvent(eventType: EventType, data?: Readonly<Record<string, unknown>>): void {
    const event: AutomationEvent = {
      type: eventType,
      timestamp: Date.now(),
      data,
    };

    const listeners = this._eventListeners.get(eventType);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback(event);
        } catch (error) {
          if (this._config.debugMode) {
            throw new AutomationError(
              `Event listener error for ${eventType}: ${error instanceof Error ? error.message : 'Unknown error'}`,
              'EXECUTION_FAILED',
              { eventType, originalError: error }
            );
          }
        }
      });
    }
  }
}
