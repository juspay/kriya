import type {
  ActionCommand,
  ActionOutcome,
  ActionType,
  AutomationConfig,
  ClickOptions,
  ErrorCode,
  EventCallback,
  EventType,
  ExecutionEffect,
  ExecutionOptions,
  ExecutionResult,
  FillOptions,
  MutationGuard,
  NavigationOptions,
  PressOptions,
  ScrollOptions,
  SelectMatchBy,
  SelectOptions,
  SetCheckedOptions,
  WaitOptions,
} from '@/types';
import { AutomationError } from '@/types';
import type { ContextCapture } from '@/context/ContextCapture';
import type { FormRegistry } from '@/forms/FormRegistry';
import { DOMActions } from '@/actions/DOMActions';
import { createMutationGuard } from '@/actions/guard';
import {
  declaresSensitive,
  isStrictExecution,
  scrubActionTextSafely,
  validateActionParameters,
} from '@/actions/parameters';

type Run = {
  readonly strict: boolean;
  readonly guard: MutationGuard;
  readonly target: HTMLElement | undefined;
  readonly signal: AbortSignal;
};

type Failure = {
  readonly code: ErrorCode;
  readonly message: string;
  readonly effect: ExecutionEffect;
  readonly data?: unknown;
};

const ELEMENT_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'click',
  'fill',
  'press',
  'select',
  'setChecked',
]);

// Legacy actions whose success always means the page was touched; used when the DOM layer did not report
// its commit, so an unreported success is never read as "nothing happened" (which would invite a retry).
const LEGACY_MUTATIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'navigate',
  'click',
  'fill',
  'press',
]);

const isOutcome = (value: unknown): value is ActionOutcome =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { readonly kind?: unknown }).kind === 'string';

// A thrown value is third-party input: a missing, non-string or throwing `message` must not turn a result
// into a rejection.
const messageOf = (error: unknown): string => {
  try {
    if (error instanceof Error && typeof error.message === 'string') {
      return error.message;
    }
  } catch {
    // a hostile message getter
  }
  return 'Unknown error occurred';
};

const abortReason = (signal: AbortSignal): AutomationError => {
  const reason: unknown = signal.reason;
  return reason instanceof AutomationError
    ? reason
    : new AutomationError('Operation was cancelled', 'EXECUTION_CANCELLED');
};

export class ActionExecutor {
  private readonly _config: AutomationConfig;
  private readonly _domActions: DOMActions;
  private readonly _inFlight: Set<AbortController>;
  private _formRegistry: FormRegistry | null;
  private _contextCapture: ContextCapture | null;
  public addEventListener: ((eventType: EventType, callback: EventCallback) => void) | null;

  constructor(config: AutomationConfig) {
    this._config = config;
    this._domActions = new DOMActions(config);
    this._inFlight = new Set();
    this._formRegistry = null;
    this._contextCapture = null;
    this.addEventListener = null;
  }

  public initialize(formRegistry: FormRegistry, contextCapture: ContextCapture): void {
    this._formRegistry = formRegistry;
    this._contextCapture = contextCapture;
    this._domActions.initialize();
  }

  public async executeAction(
    action: ActionCommand,
    options?: ExecutionOptions
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    if (typeof action !== 'object' || action === null) {
      return this._failed(action, startTime, {
        code: 'VALIDATION_FAILED',
        message: 'Action is required and must be an object',
        effect: 'none',
      });
    }
    const strict = isStrictExecution(action, options);

    if (options?.signal?.aborted === true) {
      return this._failed(action, startTime, {
        code: 'EXECUTION_CANCELLED',
        message: 'Operation was cancelled',
        effect: 'none',
      });
    }
    const rejection = strict ? this._strictRejection(action, options) : null;
    if (rejection) {
      return this._failed(action, startTime, rejection);
    }

    const controller = new AbortController();
    const guard = this._createGuard(controller.signal, options?.onCommit);
    const run: Run = { strict, guard, target: options?.target, signal: controller.signal };
    const unlink = options?.signal ? this._link(options.signal, controller) : (): void => undefined;
    this._inFlight.add(controller);

    try {
      const timeout = action.timeout ?? this._config.timeout;
      const data = await this._runWithAbort(() => this._dispatch(action, run), timeout, controller);
      return this._completed(action, run, startTime, data);
    } catch (error) {
      return await this._failure(action, run, startTime, error);
    } finally {
      unlink();
      this._inFlight.delete(controller);
    }
  }

  public dispose(): void {
    for (const controller of this._inFlight) {
      controller.abort(new AutomationError('Action executor was disposed', 'EXECUTION_CANCELLED'));
    }
    this._inFlight.clear();
    this._domActions.dispose();
    this._formRegistry = null;
    this._contextCapture = null;
    this.addEventListener = null;
  }

  private _strictRejection(action: ActionCommand, options?: ExecutionOptions): Failure | null {
    const issue = validateActionParameters(action, true);
    if (issue) {
      return { code: issue.code, message: issue.message, effect: 'none' };
    }
    const selector = action.parameters.selector;
    const hasSelector = typeof selector === 'string' && selector.length > 0;
    if (ELEMENT_ACTIONS.has(action.type) && options?.target === undefined && !hasSelector) {
      return {
        code: 'INVALID_ACTION',
        message: 'Strict action requires a target element or a selector',
        effect: 'none',
      };
    }
    return null;
  }

  private _createGuard(signal: AbortSignal, onCommit?: () => void): MutationGuard {
    const base = createMutationGuard(signal);
    let notified = false;
    return {
      get committed(): boolean {
        return base.committed;
      },
      checkpoint: base.checkpoint,
      commit: (): void => {
        base.commit();
        if (!notified) {
          notified = true;
          try {
            onCommit?.();
          } catch {
            // A faulty callback must never change the outcome of the action.
          }
        }
      },
    };
  }

  private _link(signal: AbortSignal, controller: AbortController): () => void {
    const onAbort = (): void => {
      controller.abort(new AutomationError('Operation was cancelled', 'EXECUTION_CANCELLED'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return (): void => signal.removeEventListener('abort', onAbort);
  }

  // The timer aborts the controller BEFORE the promise rejects, so no continuation of the operation can
  // pass a guard checkpoint after the caller has been told the result.
  private _runWithAbort<T>(
    operation: () => Promise<T>,
    timeout: number,
    controller: AbortController
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const signal = controller.signal;
      if (signal.aborted) {
        reject(abortReason(signal));
        return;
      }

      const timer = setTimeout(() => {
        controller.abort(
          new AutomationError(`Operation timed out after ${timeout}ms`, 'EXECUTION_TIMEOUT')
        );
      }, timeout);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortReason(signal));
      };
      const release = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort, { once: true });

      operation().then(
        value => {
          release();
          resolve(value);
        },
        (error: unknown) => {
          release();
          reject(error);
        }
      );
    });
  }

  private _completed(
    action: ActionCommand,
    run: Run,
    startTime: number,
    data: unknown
  ): ExecutionResult {
    if (run.strict && action.type === 'fillForm' && this._isIncompleteFormFill(data)) {
      return this._failed(action, startTime, {
        code: 'EXECUTION_FAILED',
        message: 'Form fill did not complete',
        effect: run.guard.committed ? 'uncertain' : 'none',
        data,
      });
    }
    const reported: ExecutionEffect = run.guard.committed ? 'applied' : 'none';
    const unreported = !run.strict && LEGACY_MUTATIONS.has(action.type);
    return {
      success: true,
      status: 'completed',
      data,
      timestamp: startTime,
      effect: reported === 'none' && unreported ? 'applied' : reported,
    };
  }

  private async _failure(
    action: ActionCommand,
    run: Run,
    startTime: number,
    error: unknown
  ): Promise<ExecutionResult> {
    const code: ErrorCode = error instanceof AutomationError ? error.code : 'EXECUTION_FAILED';
    if (
      this._config.screenshotOnError &&
      this._contextCapture &&
      !run.strict &&
      code !== 'EXECUTION_CANCELLED'
    ) {
      try {
        await this._contextCapture.captureScreenshot();
      } catch {
        // Silently ignore screenshot errors
      }
    }

    const touched = run.guard.committed;
    const unclaimed =
      (action.type === 'fillForm' || action.type === 'submitForm') && code === 'FORM_NOT_FOUND';
    return this._failed(action, startTime, {
      code,
      message: messageOf(error),
      effect: touched && !unclaimed ? 'uncertain' : 'none',
    });
  }

  private _failed(action: ActionCommand, startTime: number, failure: Failure): ExecutionResult {
    return {
      success: false,
      status: 'failed',
      ...(failure.data === undefined ? {} : { data: failure.data }),
      error: scrubActionTextSafely(failure.message, action, this._config.redactor),
      errorCode: failure.code,
      timestamp: startTime,
      effect: failure.effect,
    };
  }

  private _isIncompleteFormFill(data: unknown): boolean {
    if (typeof data !== 'object' || data === null) {
      return false;
    }
    const result = data as { readonly success?: unknown; readonly failedFields?: unknown };
    return (
      result.success === false ||
      (Array.isArray(result.failedFields) && result.failedFields.length > 0)
    );
  }

  private async _dispatch(action: ActionCommand, run: Run): Promise<unknown> {
    run.guard.checkpoint();
    switch (action.type) {
      case 'navigate':
        return this._executeNavigate(action, run);
      case 'click':
        return this._executeClick(action, run);
      case 'fill':
        return this._executeFill(action, run);
      case 'fillForm':
        return this._executeFillForm(action, run);
      case 'submitForm':
        return this._executeSubmitForm(action, run);
      case 'screenshot':
        return this._executeScreenshot(action);
      case 'wait':
        return this._executeWait(action, run);
      case 'press':
        return this._executePress(action, run);
      case 'setChecked':
        return this._executeSetChecked(action, run);
      case 'select':
        return this._executeSelect(action, run);
      case 'scroll':
        return this._executeScroll(action, run);
      default:
        throw new AutomationError('Unsupported action type', 'INVALID_ACTION', {
          parameterKeys: Object.keys(action.parameters ?? {}),
        });
    }
  }

  private _keysOf(action: ActionCommand): { readonly parameterKeys: readonly string[] } {
    return { parameterKeys: Object.keys(action.parameters ?? {}) };
  }

  private _strictOutcome(value: unknown, run: Run): ActionOutcome | undefined {
    return run.strict && isOutcome(value) ? value : undefined;
  }

  private async _executeNavigate(action: ActionCommand, run: Run): Promise<void> {
    const url = action.parameters.url;
    if (!url) {
      throw new AutomationError(
        'Navigate action requires url parameter',
        'VALIDATION_FAILED',
        this._keysOf(action)
      );
    }

    const options: NavigationOptions = {
      url,
      waitForLoad: action.parameters.waitForLoad === 'true',
      timeout: action.timeout,
    };

    return this._domActions.navigate(options, run.guard, run.signal);
  }

  private async _executeClick(action: ActionCommand, run: Run): Promise<ActionOutcome | undefined> {
    const parameters = action.parameters;
    const base: ClickOptions = {
      selector: parameters.selector,
      description: run.strict ? undefined : (parameters.description ?? action.description),
      button: (parameters.button as ClickOptions['button']) ?? 'left',
      clickCount: parseInt(parameters.clickCount ?? '1', 10),
    };
    const positioned: ClickOptions =
      parameters.x && parameters.y
        ? {
            ...base,
            position: { x: parseInt(parameters.x, 10), y: parseInt(parameters.y, 10) },
          }
        : base;
    const options: ClickOptions = run.strict ? { ...positioned, strict: true } : positioned;

    const outcome: unknown = await this._domActions.click(
      options,
      run.guard,
      run.target,
      run.signal
    );
    return this._strictOutcome(outcome, run);
  }

  private async _executeFill(action: ActionCommand, run: Run): Promise<ActionOutcome | undefined> {
    const parameters = action.parameters;
    const value = parameters.value;
    // Presence, not truthiness: '' is a legitimate value (clear the field). Other falsy values stay rejected.
    if (!value && value !== '') {
      throw new AutomationError(
        'Fill action requires value parameter',
        'VALIDATION_FAILED',
        this._keysOf(action)
      );
    }

    const base: FillOptions = {
      selector: parameters.selector,
      description: run.strict ? undefined : (parameters.description ?? action.description),
      value,
      clearFirst: parameters.clearFirst === 'true',
      triggerEvents: parameters.triggerEvents !== 'false',
    };
    const options: FillOptions = run.strict ? { ...base, strict: true } : base;

    const sensitive = declaresSensitive(action, 'value');
    const outcome: unknown = await this._domActions.fill(
      options,
      run.guard,
      run.target,
      sensitive,
      run.signal
    );
    return this._strictOutcome(outcome, run);
  }

  private async _executeFillForm(action: ActionCommand, run: Run): Promise<unknown> {
    if (!this._formRegistry) {
      throw new AutomationError('Form registry not initialized', 'INVALID_CONFIGURATION');
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
        if (!RESERVED.has(k)) {
          flat[k] = v;
        }
      }
      if (Object.keys(flat).length > 0) {
        fieldsParam = flat;
      }
    }

    if (!fieldsParam) {
      throw new AutomationError(
        'FillForm action requires fields (either a `fields`/`values` object or top-level field entries in `parameters`)',
        'VALIDATION_FAILED',
        this._keysOf(action)
      );
    }

    // Allow any value type, not just strings - supports arrays, objects, etc.
    let fields: Record<string, unknown>;
    try {
      fields = typeof fieldsParam === 'string' ? JSON.parse(fieldsParam) : fieldsParam;
    } catch {
      throw new AutomationError(
        'Invalid fields parameter format',
        'VALIDATION_FAILED',
        this._keysOf(action)
      );
    }

    if (run.strict) {
      if (!formId) {
        throw new AutomationError(
          'Strict form fill requires a registered form ID',
          'INVALID_ACTION'
        );
      }
      return this._formRegistry.fillFormStrict(formId, fields, run.guard);
    }

    // A payload that is not an object cannot write anything: the registry rejects it before touching a form.
    if (typeof fields === 'object' && fields !== null) {
      run.guard.commit();
    } else {
      run.guard.checkpoint();
    }
    return formId
      ? this._formRegistry.fillForm(formId, fields, run.guard, run.signal)
      : this._formRegistry.fillAnyForm(fields, run.guard, run.signal);
  }

  private async _executeSubmitForm(action: ActionCommand, run: Run): Promise<unknown> {
    if (!this._formRegistry) {
      throw new AutomationError('Form registry not initialized', 'INVALID_CONFIGURATION');
    }

    const formId = action.parameters.formId;

    run.guard.commit();
    return formId ? this._formRegistry.submitForm(formId) : this._formRegistry.submitAnyForm();
  }

  private async _executeScreenshot(action: ActionCommand): Promise<string> {
    if (!this._contextCapture) {
      throw new AutomationError('Context capture not initialized', 'INVALID_CONFIGURATION');
    }

    const fullPage = action.parameters.fullPage === 'true';
    const quality = parseFloat(action.parameters.quality ?? '0.9');

    return this._contextCapture.captureScreenshot({
      fullPage,
      quality,
      format: 'png',
    });
  }

  private async _executeWait(action: ActionCommand, run: Run): Promise<ActionOutcome | undefined> {
    const parameters = action.parameters;
    // The one-second default applies only when no selector+condition was given to wait for instead.
    const awaitsCondition = Boolean(parameters.selector && parameters.condition);
    const options: WaitOptions = {
      duration:
        parameters.duration === undefined
          ? awaitsCondition
            ? undefined
            : 1000
          : parseInt(parameters.duration, 10),
      selector: parameters.selector,
      condition: parameters.condition as WaitOptions['condition'],
      timeout: action.timeout,
    };

    const started = Date.now();
    const outcome: unknown = await this._domActions.wait(options, run.guard);
    if (!run.strict) {
      return undefined;
    }
    return isOutcome(outcome) ? outcome : { kind: 'wait', waitedMs: Date.now() - started };
  }

  private async _executePress(action: ActionCommand, run: Run): Promise<ActionOutcome | undefined> {
    const key = action.parameters.key;
    if (!key) {
      throw new AutomationError(
        'Press action requires key parameter',
        'VALIDATION_FAILED',
        this._keysOf(action)
      );
    }

    const base: PressOptions = {
      key,
      selector: action.parameters.selector,
      description: action.parameters.description,
    };
    const options: PressOptions = run.strict
      ? {
          ...base,
          description: undefined,
          strict: true,
          implicitSubmit: action.parameters.implicitSubmit === 'true',
        }
      : base;

    const outcome: unknown = await this._domActions.press(options, run.guard, run.target);
    return this._strictOutcome(outcome, run);
  }

  private async _executeSetChecked(
    action: ActionCommand,
    run: Run
  ): Promise<ActionOutcome | undefined> {
    const options: SetCheckedOptions = {
      selector: action.parameters.selector,
      checked: action.parameters.checked === 'true',
      strict: true,
    };

    const outcome: unknown = await this._domActions.setChecked(options, run.guard, run.target);
    return isOutcome(outcome) ? outcome : undefined;
  }

  private async _executeSelect(
    action: ActionCommand,
    run: Run
  ): Promise<ActionOutcome | undefined> {
    // Without matchBy and option the target is an ARIA option element. 'index' with a blank option can
    // never match a native select by accident, unlike 'value' with '' which would pick a placeholder.
    const options: SelectOptions = {
      selector: action.parameters.selector,
      matchBy: (action.parameters.matchBy as SelectMatchBy | undefined) ?? 'index',
      option: action.parameters.option ?? '',
      triggerEvents: action.parameters.triggerEvents !== 'false',
      strict: true,
    };

    const outcome: unknown = await this._domActions.select(options, run.guard, run.target);
    return isOutcome(outcome) ? outcome : undefined;
  }

  private async _executeScroll(
    action: ActionCommand,
    run: Run
  ): Promise<ActionOutcome | undefined> {
    const options: ScrollOptions = {
      selector: action.parameters.selector,
      direction: action.parameters.direction as ScrollOptions['direction'],
      strict: true,
    };

    const outcome: unknown = await this._domActions.scroll(options, run.guard, run.target);
    return isOutcome(outcome) ? outcome : undefined;
  }
}
