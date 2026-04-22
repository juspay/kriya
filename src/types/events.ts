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
