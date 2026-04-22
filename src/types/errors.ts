export type ErrorCode =
  | 'INVALID_ACTION'
  | 'ELEMENT_NOT_FOUND'
  | 'FORM_NOT_REGISTERED'
  | 'FORM_NOT_FOUND'
  | 'FIELD_NOT_FOUND'
  | 'EXECUTION_TIMEOUT'
  | 'EXECUTION_FAILED'
  | 'NETWORK_ERROR'
  | 'PERMISSION_DENIED'
  | 'INVALID_CONFIGURATION'
  | 'SCREENSHOT_FAILED'
  | 'VALIDATION_FAILED'
  | 'BROWSER_NOT_SUPPORTED';

export class AutomationError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly context?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = 'AutomationError';
  }
}
