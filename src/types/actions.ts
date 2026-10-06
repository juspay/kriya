import type { ErrorCode } from './errors';

export const ACTION_TYPES = [
  'navigate',
  'click',
  'fill',
  'fillForm',
  'submitForm',
  'screenshot',
  'wait',
  'press',
  'setChecked',
  'select',
  'scroll',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export type ActionCommand = {
  readonly type: ActionType;
  readonly parameters: Readonly<Record<string, string>>;
  readonly timeout?: number;
  readonly description?: string;
  /**
   * Parameter names whose values must never reach events, logs, error messages or contexts.
   * The executor redacts them by name and by value.
   */
  readonly sensitiveParameters?: readonly string[];
};

export type ExecutionStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * none: the action stopped before its first page mutation (safe to retry).
 * applied: the mutation happened.
 * uncertain: cancelled or timed out after the mutation boundary, or failed after it; never retry blindly.
 * Every result of the repaired executor sets it; optional only so custom executors stay assignable.
 */
export type ExecutionEffect = 'none' | 'applied' | 'uncertain';

export type ExecutionResult = {
  readonly success: boolean;
  readonly status: ExecutionStatus;
  readonly data?: unknown;
  readonly error?: string;
  readonly errorCode?: ErrorCode;
  readonly timestamp: number;
  readonly effect?: ExecutionEffect;
};

/**
 * Strict mode is on when ANY of these holds: `strict` is true, `target` is present, the command's
 * `parameters.strict` is 'true'. It never turns off once on. A strict action with neither `target` nor a
 * `selector` parameter fails INVALID_ACTION with effect 'none' (a value-free message): it never falls back
 * to text matching or to another element.
 */
export type ExecutionOptions = {
  readonly signal?: AbortSignal;
  /** Exact element to act on. Implies strict mode. In-page only, never serialized. */
  readonly target?: HTMLElement;
  /** Strict mode: exact-target semantics, no text-matching fallback, value-free outcomes. */
  readonly strict?: boolean;
  /**
   * Called at most once, synchronously, at the instant the mutation boundary is crossed (the moment
   * `guard.committed` becomes true), never for an idempotent no-op or a rejected action. An exception thrown
   * by the callback is swallowed. The in-page bridge uses it to answer a cancel request truthfully
   * (before_commit or after_commit); the executor otherwise owns its MutationGuard.
   */
  readonly onCommit?: () => void;
};

export type MutationGuard = {
  readonly committed: boolean;
  /** Throws AutomationError EXECUTION_CANCELLED when aborted. Never changes state. */
  readonly checkpoint: () => void;
  /** checkpoint(), then marks the mutation boundary crossed. Call immediately before the first page mutation. */
  readonly commit: () => void;
};

export type ActionParameterIssue = {
  readonly code: ErrorCode;
  readonly key?: string;
  readonly message: string;
};

export type NavigationOptions = {
  readonly url: string;
  readonly waitForLoad: boolean;
  readonly timeout?: number;
};

export type ClickOptions = {
  readonly selector?: string;
  readonly description?: string;
  readonly position?: { x: number; y: number };
  readonly button: 'left' | 'right' | 'middle';
  readonly clickCount: number;
  readonly strict?: boolean;
};

export type FillOptions = {
  readonly selector?: string;
  readonly description?: string;
  readonly value: string;
  readonly clearFirst: boolean;
  readonly triggerEvents: boolean;
  /**
   * Exact-target semantics: the selector must resolve to exactly one connected editable element,
   * no text matching, no neighbour fallback, '' is a valid value. Absent or false keeps legacy behavior.
   */
  readonly strict?: boolean;
};

export type WaitOptions = {
  readonly duration?: number;
  readonly selector?: string;
  readonly condition?: 'visible' | 'hidden' | 'enabled' | 'disabled';
  readonly timeout?: number;
};

export type PressOptions = {
  readonly key: string;
  readonly selector?: string;
  readonly description?: string;
  readonly strict?: boolean;
  /** Strict mode only: run the default action of Enter and Space (implicit form submission, activation). */
  readonly implicitSubmit?: boolean;
};

export type SetCheckedOptions = {
  readonly selector?: string;
  readonly description?: string;
  readonly checked: boolean;
  readonly strict?: boolean;
};

export type SelectMatchBy = 'value' | 'label' | 'index';

export type SelectOptions = {
  readonly selector?: string;
  readonly description?: string;
  readonly matchBy: SelectMatchBy;
  readonly option: string;
  readonly triggerEvents: boolean;
  readonly strict?: boolean;
};

export type ScrollDirectionName = 'UP' | 'DOWN' | 'TOP' | 'BOTTOM';

export type ScrollOptions = {
  readonly selector?: string;
  readonly direction: ScrollDirectionName;
  readonly strict?: boolean;
};

export type ActionCheckedState = boolean | 'mixed';

export type ActionSubmitInfo = {
  /** A submit event fired during the activation. */
  readonly event: boolean;
  /** Number of controls that blocked submission through native validation. */
  readonly invalidControls: number;
  readonly defaultPrevented: boolean;
};

/**
 * Value-free outcome returned in ExecutionResult.data by the strict actions. It never contains
 * text that was typed or selected; only booleans, counts, indexes and pixel metrics.
 */
export type ActionOutcome =
  | {
      readonly kind: 'click';
      readonly defaultPrevented: boolean;
      readonly submit?: ActionSubmitInfo;
    }
  | {
      readonly kind: 'fill';
      readonly tag: string;
      readonly inputType: string;
      /**
       * Length of the element value after the write. OMITTED when the command listed `value` in
       * `sensitiveParameters` or the target is sensitive: a length is an oracle for a password or card
       * number and would flow into the readback, ledger, events and history. `empty` is then the only
       * size information.
       */
      readonly length?: number;
      /** The element value is '' after the write. Always set by the repaired executor. */
      readonly empty?: boolean;
      readonly changed: boolean;
      /** The element value equals the requested value after the write. */
      readonly matched: boolean;
    }
  | {
      readonly kind: 'select';
      readonly control: 'native' | 'aria';
      readonly index: number;
      readonly changed: boolean;
      /** null when the ARIA widget could not confirm the selection synchronously. */
      readonly matched: boolean | null;
    }
  | {
      readonly kind: 'setChecked';
      readonly control: 'native' | 'aria';
      readonly before: ActionCheckedState;
      readonly after: ActionCheckedState;
      readonly changed: boolean;
      readonly matched: boolean;
    }
  | {
      readonly kind: 'scroll';
      readonly moved: boolean;
      readonly reason?: 'edge' | 'blocked';
      readonly before: number;
      readonly after: number;
      readonly max: number;
      readonly atTop: boolean;
      readonly atBottom: boolean;
    }
  | {
      readonly kind: 'press';
      readonly defaultPrevented: boolean;
      readonly defaultAction: 'implicit_submit' | 'activate' | 'none';
      readonly submit?: ActionSubmitInfo;
    }
  | {
      readonly kind: 'wait';
      readonly waitedMs: number;
    };
