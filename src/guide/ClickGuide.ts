import type {
  ClickGuideOptions,
  GuideDecideResult,
  GuideDecider,
  GuideHistoryEntry,
  GuideStepResult,
} from '@/guide/types';
import { isElementOperation } from '@/guide/types';
import { clearHighlight, paintHighlight, setGuidePace } from '@/guide/highlight';
import { elementForGuideIndex, observePage, resetGuideCache } from '@/guide/observe';
import { buildGuideRequest } from '@/guide/request';

const DEFAULT_MAX_STEPS = 12;
const RESTEP_DELAY_MS = 50;

export class ClickGuide {
  private readonly _maxSteps: number;
  private readonly _autoContinue: boolean;
  private readonly _model: string;
  private readonly _mark: 'jev' | 'guide';
  private readonly _onClick: (event: MouseEvent) => void;
  private _goal = '';
  private _decider: GuideDecider | null = null;
  private _history: readonly GuideHistoryEntry[] = [];
  private _steps = 0;
  private _generation = 0;
  private _fingerprint = '';
  private _highlightedIndex: string | null = null;
  private _highlightedLabel = '';
  private _listening = false;
  private _lastResult: GuideStepResult = { ok: false, error: 'Guide has not started', steps: 0 };

  public constructor(options: ClickGuideOptions = {}) {
    this._maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this._autoContinue = options.autoContinue ?? true;
    this._model = options.model ?? 'jev-latest';
    this._mark = options.mark ?? 'guide';
    this._onClick = (event: MouseEvent): void => {
      this._handleClick(event);
    };
  }

  public async start(goal: string, decider: GuideDecider): Promise<GuideStepResult> {
    this.stop();
    this._goal = goal;
    this._decider = decider;
    this._history = [];
    this._steps = 0;
    this._fingerprint = '';
    this._generation += 1;
    if (this._autoContinue) {
      document.addEventListener('click', this._onClick, true);
      this._listening = true;
    }
    return this._step();
  }

  public stop(): void {
    this._generation += 1;
    this._decider = null;
    this._highlightedIndex = null;
    if (this._listening) {
      document.removeEventListener('click', this._onClick, true);
      this._listening = false;
    }
    clearHighlight();
  }

  public dispose(): void {
    this.stop();
    resetGuideCache();
  }

  private async _step(): Promise<GuideStepResult> {
    if (this._steps >= this._maxSteps) {
      this.stop();
      return this._remember({
        ok: false,
        error: `Stopped after ${String(this._maxSteps)} steps`,
        steps: this._steps,
      });
    }
    const decider = this._decider;
    if (decider === null) {
      return this._remember({ ok: false, error: 'Guide is stopped', steps: this._steps });
    }
    const observation = observePage();
    if (observation.fingerprint === this._fingerprint && this._steps > 0) {
      return this._lastResult;
    }
    this._fingerprint = observation.fingerprint;
    const request = buildGuideRequest(observation, this._goal, this._history, this._model);
    const started = performance.now();
    let decision: GuideDecideResult;
    try {
      decision = await decider(request);
    } catch (error: unknown) {
      return this._remember({
        ok: false,
        error: error instanceof Error ? error.message : 'Decider failed',
        steps: this._steps,
        latencyMs: elapsed(started),
      });
    }
    const latencyMs = elapsed(started);
    this._steps += 1;
    if (!decision.ok) {
      clearHighlight();
      this._highlightedIndex = null;
      return this._remember({ ok: false, error: decision.error, steps: this._steps, latencyMs });
    }
    if (!isElementOperation(decision.operation)) {
      clearHighlight();
      this._highlightedIndex = null;
      if (decision.operation === 'DONE' || decision.operation === 'BLOCKED') {
        this.stop();
      }
      return this._remember({
        ok: true,
        operation: decision.operation,
        confidence: decision.confidence,
        steps: this._steps,
        latencyMs,
      });
    }
    const targetIndex = decision.targetIndex;
    if (targetIndex === undefined || targetIndex === '') {
      return this._remember({
        ok: false,
        error: `${decision.operation} did not name a target`,
        steps: this._steps,
        latencyMs,
      });
    }
    const element = elementForGuideIndex(targetIndex);
    if (element === undefined) {
      clearHighlight();
      this._highlightedIndex = null;
      return this._remember({
        ok: false,
        error: `Target ${targetIndex} is not on the page`,
        steps: this._steps,
        latencyMs,
      });
    }
    this._highlightedIndex = targetIndex;
    this._highlightedLabel = elementLabel(observation.elements, targetIndex);
    paintHighlight(element, this._goal);
    setGuidePace(latencyMs, this._mark);
    return this._remember({
      ok: true,
      operation: decision.operation,
      targetIndex,
      label: this._highlightedLabel,
      confidence: decision.confidence,
      steps: this._steps,
      latencyMs,
    });
  }

  private _handleClick(event: MouseEvent): void {
    const index = this._highlightedIndex;
    if (index === null || this._decider === null) {
      return;
    }
    const element = elementForGuideIndex(index);
    if (
      element === undefined ||
      !(event.target instanceof Node) ||
      !element.contains(event.target)
    ) {
      return;
    }
    const label = this._highlightedLabel;
    this._history = [...this._history, { action: label, kind: 'click', pageChanged: true }].slice(
      -10
    );
    const generation = this._generation + 1;
    this._generation = generation;
    window.setTimeout(() => {
      if (generation !== this._generation || this._decider === null) {
        return;
      }
      void this._step().then(
        () => undefined,
        () => undefined
      );
    }, RESTEP_DELAY_MS);
  }

  private _remember(result: GuideStepResult): GuideStepResult {
    this._lastResult = result;
    return result;
  }
}

export function createClickGuide(options: ClickGuideOptions = {}): ClickGuide {
  return new ClickGuide(options);
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

function elementLabel(
  elements: readonly {
    readonly index: string;
    readonly label: string;
    readonly options?: readonly { readonly index: string; readonly label: string }[];
  }[],
  targetIndex: string
): string {
  for (const element of elements) {
    if (element.index === targetIndex) {
      return element.label;
    }
    for (const option of element.options ?? []) {
      if (option.index === targetIndex) {
        return option.label;
      }
    }
  }
  return targetIndex;
}
