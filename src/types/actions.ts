import type { ErrorCode } from './errors';

export type ActionType =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'fillForm'
  | 'submitForm'
  | 'screenshot'
  | 'wait'
  | 'press';

export type ActionCommand = {
  readonly type: ActionType;
  readonly parameters: Readonly<Record<string, string>>;
  readonly timeout?: number;
  readonly description?: string;
};

export type ExecutionStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type ExecutionResult = {
  readonly success: boolean;
  readonly status: ExecutionStatus;
  readonly data?: unknown;
  readonly error?: string;
  readonly errorCode?: ErrorCode;
  readonly timestamp: number;
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
};

export type FillOptions = {
  readonly selector?: string;
  readonly description?: string;
  readonly value: string;
  readonly clearFirst: boolean;
  readonly triggerEvents: boolean;
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
};
