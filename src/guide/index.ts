export { ClickGuide, createClickGuide } from '@/guide/ClickGuide';
export { ResearchGuide, createResearchGuide } from '@/guide/ResearchGuide';
export type { ResearchEvidence, ResearchGuideOptions, ResearchResult } from '@/types';
export {
  GUIDE_HIGHLIGHT_ID,
  GUIDE_STATUS_ID,
  clearHighlight,
  paintHighlight,
  setGuidePace,
} from '@/guide/highlight';
export { JEV_BAR_ID, mountJevGuide } from '@/guide/surface';
export { elementForGuideIndex, observePage, resetGuideCache } from '@/guide/observe';
export type { GuideObservationOptions } from '@/types';
export { buildGuideRequest, targetQuestionKey } from '@/guide/request';
export { createTypeSafeDecider, decisionFromBody } from '@/guide/typesafe';
export type {
  ChoiceCriterion,
  ChoiceQuestion,
  ClickGuideOptions,
  GuideControl,
  GuideDecideResult,
  GuideDecider,
  GuideElement,
  GuideElementOperation,
  GuideHistoryEntry,
  GuideHttp,
  GuideHttpRequest,
  GuideHttpResponse,
  GuideObservation,
  GuideOperation,
  GuideOption,
  GuideStepResult,
  SystemOneRequest,
  TypeSafeDeciderConfig,
} from '@/guide/types';
export type { JevGuideSession, MountJevGuideOptions } from '@/guide/surface';
