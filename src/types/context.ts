import type { FormContext } from './forms';

export type ViewportInfo = {
  readonly width: number;
  readonly height: number;
  readonly scrollX: number;
  readonly scrollY: number;
};

export type ElementContext = {
  readonly tagName: string;
  readonly id?: string;
  readonly className?: string;
  readonly textContent?: string;
  readonly type?: string;
  readonly value?: string;
  readonly href?: string;
  readonly clickable: boolean;
  readonly visible: boolean;
};

export type PageContext = {
  readonly pageUrl: string;
  readonly title: string;
  readonly timestamp: number;
  readonly totalFormsFound: number;
  readonly forms: readonly FormContext[];
  readonly elements: readonly ElementContext[];
  readonly viewport: ViewportInfo;
};

export type ClipRegion = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type ScreenshotOptions = {
  readonly fullPage: boolean;
  readonly quality: number;
  readonly format: 'png' | 'jpeg' | 'webp';
  readonly clip?: ClipRegion;
};

export type ContextCaptureConfig = {
  readonly includeScreenshot: boolean;
  readonly includeFormData: boolean;
  readonly includeElementData: boolean;
  readonly maxElementsPerPage: number;
};

export const DEFAULT_CONTEXT_CAPTURE_CONFIG: ContextCaptureConfig = {
  includeScreenshot: true,
  includeFormData: true,
  includeElementData: true,
  maxElementsPerPage: 100,
} as const;
