export const GUIDE_ELEMENT_OPERATIONS = ['CLICK', 'TYPE_TEXT', 'SELECT', 'HIGHLIGHT'] as const;

export type GuideElementOperation = (typeof GUIDE_ELEMENT_OPERATIONS)[number];

export const GUIDE_OPERATIONS = [
  'CLICK',
  'TYPE_TEXT',
  'SELECT',
  'HIGHLIGHT',
  'SCROLL_UP',
  'SCROLL_DOWN',
  'WAIT',
  'DONE',
  'BLOCKED',
] as const;

export type GuideOperation = (typeof GUIDE_OPERATIONS)[number];

export type GuideOption = {
  readonly index: string;
  readonly label: string;
};

export type GuideElement = {
  readonly index: string;
  readonly role: string;
  readonly label: string;
  readonly operations: readonly GuideElementOperation[];
  readonly text?: string;
  readonly href?: string;
  readonly value?: string;
  readonly checked?: string;
  readonly options?: readonly GuideOption[];
};

export type GuideControl = {
  readonly operation: 'SCROLL_UP' | 'SCROLL_DOWN' | 'WAIT';
  readonly label: string;
};

export type GuideObservation = {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly elements: readonly GuideElement[];
  readonly controls: readonly GuideControl[];
  readonly fingerprint: string;
};

export type GuideHistoryEntry = {
  readonly action: string;
  readonly kind: string;
  readonly pageChanged: boolean;
  readonly url?: string;
};

export type ChoiceCriterion = string | Readonly<Record<string, string>>;

export type ChoiceQuestion = {
  readonly type: 'choice';
  readonly instructions: Readonly<Record<string, string>>;
  readonly criteria: Readonly<Record<string, ChoiceCriterion>>;
};

export type SystemOneRequest = {
  readonly model: string;
  readonly state: {
    readonly task: string;
    readonly page: {
      readonly url: string;
      readonly title: string;
      readonly text: string;
    };
    readonly elements: readonly GuideElement[];
    readonly controls: readonly GuideControl[];
    readonly recentActions: readonly GuideHistoryEntry[];
    readonly objective?: string;
    readonly evidence?: readonly { readonly url: string; readonly text: string }[];
  };
  readonly questions: Readonly<Record<string, ChoiceQuestion>>;
};

export type GuideDecideResult =
  | {
      readonly ok: true;
      readonly operation: GuideOperation;
      readonly targetIndex?: string;
      readonly confidence: number;
      readonly answer?: 'YES' | 'NO' | 'UNKNOWN';
      readonly answerConfidence?: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export type GuideDecider = (request: SystemOneRequest) => Promise<GuideDecideResult>;

export type GuideHttpRequest = {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type GuideHttpResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
};

export type GuideHttp = (url: string, init: GuideHttpRequest) => Promise<GuideHttpResponse>;

export type TypeSafeDeciderConfig = {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly http?: GuideHttp;
};

export type ClickGuideOptions = {
  readonly maxSteps?: number;
  readonly autoContinue?: boolean;
  readonly model?: string;
  readonly mark?: 'jev' | 'guide';
};

export type GuideStepResult = {
  readonly ok: boolean;
  readonly error?: string;
  readonly operation?: GuideOperation;
  readonly targetIndex?: string;
  readonly label?: string;
  readonly confidence?: number;
  readonly steps: number;
  readonly latencyMs?: number;
};

export function isGuideOperation(value: string): value is GuideOperation {
  return (GUIDE_OPERATIONS as readonly string[]).includes(value);
}

export function isElementOperation(value: GuideOperation): value is GuideElementOperation {
  return value === 'CLICK' || value === 'TYPE_TEXT' || value === 'SELECT' || value === 'HIGHLIGHT';
}

export type GuideObservationOptions = {
  readonly includeText?: boolean;
  readonly includeOffscreen?: boolean;
  readonly allowElement?: (element: HTMLElement) => boolean;
};

export type ResearchEvidence = { readonly url: string; readonly text: string };

export type ResearchResult = {
  readonly ok: boolean;
  readonly status: 'success' | 'failure' | 'cancelled';
  readonly steps: number;
  readonly evidence: readonly ResearchEvidence[];
  readonly error?: string;
  readonly confidence?: number;
  readonly answer?: 'YES' | 'NO' | 'UNKNOWN';
};

export type ResearchGuideOptions = {
  readonly model?: string;
  readonly maxSteps?: number;
  readonly minConfidence?: number;
  readonly minActionConfidence?: number;
  readonly allowedOrigins?: readonly string[];
  readonly allowElement?: (element: HTMLElement) => boolean;
  readonly allowReading?: (element: HTMLElement) => boolean;
  readonly allowNavigation?: (element: HTMLElement) => boolean;
  readonly execute?: (step: GuideStepResult, element: HTMLElement | undefined) => Promise<void>;
  readonly onThinking?: () => void;
  readonly onStep?: (step: GuideStepResult) => void | Promise<void>;
};
