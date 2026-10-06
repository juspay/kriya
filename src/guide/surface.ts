import { ClickGuide, createClickGuide } from '@/guide/ClickGuide';
import { clearHighlight } from '@/guide/highlight';
import { createTypeSafeDecider } from '@/guide/typesafe';
import type { GuideDecider, GuideHttp, GuideStepResult } from '@/guide/types';

export const JEV_BAR_ID = 'kriya-jev-bar';

export type JevGuideSession = {
  readonly guide: ClickGuide;
  readonly bar: HTMLElement;
  submit: (goal: string) => Promise<GuideStepResult>;
  close: () => void;
};

export type MountJevGuideOptions = {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly http?: GuideHttp;
  readonly decider?: GuideDecider;
  readonly parent?: HTMLElement;
};

export function mountJevGuide(options: MountJevGuideOptions = {}): JevGuideSession {
  const parent = options.parent ?? document.body;
  const decider = resolveDecider(options);
  const source = options.decider === undefined ? 'jev' : 'guide';
  const guide = createClickGuide({ mark: source });
  const bar = renderBar();
  parent.appendChild(bar);

  const input = bar.querySelector('input');
  const send = bar.querySelector('button');
  if (!(input instanceof HTMLInputElement) || !(send instanceof HTMLButtonElement)) {
    throw new Error('Jev bar did not render');
  }

  const submit = async (goal: string): Promise<GuideStepResult> => {
    const task = goal.trim();
    if (task === '') {
      return { ok: false, error: 'Say what you are looking for', steps: 0 };
    }
    if (decider === null) {
      return { ok: false, error: 'Add a TypeSafe API key to ask Jev', steps: 0 };
    }
    bar.dataset.state = 'thinking';
    send.disabled = true;
    const result = await guide.start(task, decider);
    bar.dataset.state = 'ready';
    send.disabled = false;
    return result;
  };

  send.addEventListener('click', () => {
    void submit(input.value);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit(input.value);
    }
  });

  return {
    guide,
    bar,
    submit,
    close: (): void => {
      guide.dispose();
      clearHighlight();
      bar.remove();
    },
  };
}

function resolveDecider(options: MountJevGuideOptions): GuideDecider | null {
  if (options.decider !== undefined) {
    return options.decider;
  }
  const apiKey = options.apiKey?.trim() ?? '';
  if (apiKey === '') {
    return null;
  }
  return createTypeSafeDecider({
    apiKey,
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    ...(options.http !== undefined ? { http: options.http } : {}),
  });
}

function renderBar(): HTMLElement {
  const bar = document.createElement('div');
  bar.id = JEV_BAR_ID;
  bar.setAttribute('data-kriya-guide', 'bar');
  bar.dataset.state = 'ready';
  bar.innerHTML = `
    <span data-kriya-mark="true">J</span>
    <input type="text" aria-label="What are you looking for" placeholder="Say what you are looking for" />
    <button type="button">Next</button>
  `;
  const style = document.createElement('style');
  style.setAttribute('data-kriya-guide', 'bar-style');
  style.textContent = `
    #${JEV_BAR_ID} {
      position: fixed;
      top: 18px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 10px;
      width: min(460px, calc(100vw - 28px));
      padding: 8px 8px 8px 12px;
      border-radius: 20px;
      background: rgba(255, 252, 248, 0.9);
      color: #1c1424;
      box-shadow:
        0 0 0 1px rgba(255, 255, 255, 0.9),
        0 24px 60px rgba(49, 16, 84, 0.18);
      backdrop-filter: blur(16px);
      font: 15px/1.2 "Iowan Old Style", Palatino, Georgia, serif;
    }
    #${JEV_BAR_ID} [data-kriya-mark] {
      width: 32px;
      height: 32px;
      display: grid;
      place-items: center;
      border-radius: 11px;
      background: #4c1d95;
      color: #f5f3ff;
      font-weight: 600;
      flex: none;
    }
    #${JEV_BAR_ID} input {
      flex: 1;
      min-width: 0;
      border: 0;
      outline: 0;
      background: transparent;
      color: inherit;
      font: inherit;
    }
    #${JEV_BAR_ID} button {
      border: 0;
      border-radius: 14px;
      padding: 8px 14px;
      background: #4c1d95;
      color: white;
      font: 13px/1 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      cursor: pointer;
    }
    #${JEV_BAR_ID}[data-state="thinking"] button {
      opacity: 0.65;
    }
  `;
  bar.appendChild(style);
  return bar;
}
