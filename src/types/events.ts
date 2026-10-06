import type { ActionType, ExecutionEffect } from './actions';
import type { ErrorCode } from './errors';

export type EventType =
  | 'form_registered'
  | 'form_unregistered'
  | 'form_filled'
  | 'form_submitted'
  | 'action_started'
  | 'action_completed'
  | 'action_failed'
  | 'context_captured'
  | 'screenshot_taken';

export type AutomationEvent = {
  readonly type: EventType;
  readonly timestamp: number;
  readonly data?: Readonly<Record<string, unknown>>;
};

export type EventCallback = (event: AutomationEvent) => void;

/** Payload of action_started. Parameters listed in ActionCommand.sensitiveParameters hold the redaction marker. */
export type ActionStartedEventData = {
  readonly action: ActionType | 'initialize';
  readonly parameters?: Readonly<Record<string, string>>;
};

export type ActionCompletedEventData = {
  readonly action: ActionType;
  readonly result?: unknown;
  readonly effect?: ExecutionEffect;
};

/** The error text is scrubbed of sensitive values before it is emitted. */
export type ActionFailedEventData = {
  readonly action: ActionType | 'initialize';
  readonly error?: string;
  readonly errorCode?: ErrorCode;
  readonly effect?: ExecutionEffect;
};
