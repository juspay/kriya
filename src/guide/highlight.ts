export const GUIDE_HIGHLIGHT_ID = 'kriya-click-guide-highlight';
export const GUIDE_STATUS_ID = 'kriya-click-guide-status';
export const GUIDE_STYLE_ID = 'kriya-jev-style';

const MOVE =
  'top 780ms cubic-bezier(0.22, 1, 0.36, 1), left 780ms cubic-bezier(0.22, 1, 0.36, 1), width 780ms cubic-bezier(0.22, 1, 0.36, 1), height 780ms cubic-bezier(0.22, 1, 0.36, 1), border-radius 780ms cubic-bezier(0.22, 1, 0.36, 1)';

let highlighted: HTMLElement | null = null;
let listening = false;

export function paintHighlight(element: HTMLElement, goal: string): void {
  ensureStyle();
  if (document.body === null) {
    return;
  }
  highlighted = element;
  const existing = document.getElementById(GUIDE_HIGHLIGHT_ID);
  const box = existing ?? document.createElement('div');
  if (existing === null) {
    box.id = GUIDE_HIGHLIGHT_ID;
    box.setAttribute('data-kriya-guide', 'highlight');
    const hand = document.createElement('span');
    hand.setAttribute('data-kriya-guide', 'hand');
    hand.innerHTML =
      '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="#111" stroke="#fff" stroke-width="1.4" d="M8 11V5.5a1.5 1.5 0 0 1 3 0V11m0 0V4.8a1.5 1.5 0 0 1 3 0V12m0-1.2V6.2a1.5 1.5 0 0 1 3 0V13c0 4-2.2 7-6.2 7H9.5C6.5 20 4 17.4 4 14.2V9.5a1.5 1.5 0 0 1 3 0V12"/></svg>';
    box.appendChild(hand);
    document.body.appendChild(box);
  }
  placeBox(box, element);

  let status = document.getElementById(GUIDE_STATUS_ID);
  if (status === null) {
    status = document.createElement('div');
    status.id = GUIDE_STATUS_ID;
    status.setAttribute('data-kriya-guide', 'status');
    const goalNode = document.createElement('span');
    goalNode.setAttribute('data-kriya-guide', 'goal');
    const pace = document.createElement('span');
    pace.setAttribute('data-kriya-guide', 'pace');
    status.append(goalNode, pace);
    document.body.appendChild(status);
  }
  const goalNode = status.querySelector('[data-kriya-guide="goal"]');
  if (goalNode !== null) {
    goalNode.textContent = goal;
  }
  listen();
}

export function setGuidePace(latencyMs: number, source: 'jev' | 'guide'): void {
  const pace = document.querySelector('[data-kriya-guide="pace"]');
  if (pace === null) {
    return;
  }
  const mark = source === 'jev' ? 'Jev' : 'Guide';
  pace.textContent = `${mark} · ${String(latencyMs)}ms`;
}

export function clearHighlight(): void {
  highlighted = null;
  document.getElementById(GUIDE_HIGHLIGHT_ID)?.remove();
  document.getElementById(GUIDE_STATUS_ID)?.remove();
  if (listening) {
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
    listening = false;
  }
}

function listen(): void {
  if (listening) {
    return;
  }
  listening = true;
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
}

function reposition(): void {
  const box = document.getElementById(GUIDE_HIGHLIGHT_ID);
  if (highlighted === null || box === null || !highlighted.isConnected) {
    clearHighlight();
    return;
  }
  placeBox(box, highlighted);
}

function placeBox(box: HTMLElement, element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  const radius = window.getComputedStyle(element).borderTopLeftRadius;
  box.style.borderRadius = radius === '' || radius === '0px' ? '14px' : radius;
  box.style.top = `${String(rect.top - 6)}px`;
  box.style.left = `${String(rect.left - 6)}px`;
  box.style.width = `${String(rect.width + 12)}px`;
  box.style.height = `${String(rect.height + 12)}px`;
}

function ensureStyle(): void {
  if (document.getElementById(GUIDE_STYLE_ID) !== null) {
    return;
  }
  const style = document.createElement('style');
  style.id = GUIDE_STYLE_ID;
  style.setAttribute('data-kriya-guide', 'style');
  style.textContent = `
    #${GUIDE_HIGHLIGHT_ID} {
      position: fixed;
      pointer-events: none;
      z-index: 2147483646;
      background: rgba(196, 181, 253, 0.38);
      box-shadow:
        0 0 0 2px rgba(167, 139, 250, 0.95),
        0 0 16px 4px rgba(192, 132, 252, 0.72),
        0 0 36px 12px rgba(196, 181, 253, 0.45);
      transition: ${MOVE};
      animation: kriya-jev-breathe 1.6s ease-in-out infinite;
    }
    #${GUIDE_HIGHLIGHT_ID} [data-kriya-guide="hand"] {
      position: absolute;
      right: 8%;
      bottom: -6px;
      width: 28px;
      height: 28px;
      filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.35));
    }
    #${GUIDE_STATUS_ID} {
      position: fixed;
      right: 18px;
      bottom: 18px;
      display: flex;
      align-items: center;
      gap: 10px;
      max-width: min(420px, calc(100vw - 32px));
      padding: 8px 10px 8px 14px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.94);
      color: #4c1d95;
      font: 13px/1.2 "Iowan Old Style", Palatino, Georgia, serif;
      letter-spacing: 0.01em;
      pointer-events: none;
      z-index: 2147483646;
      box-shadow: 0 12px 40px rgba(28, 16, 46, 0.28);
    }
    #${GUIDE_STATUS_ID} [data-kriya-guide="pace"] {
      font: 11px/1 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 4px 8px;
      border-radius: 999px;
      background: rgba(196, 181, 253, 0.18);
      color: #ddd6fe;
    }
    @keyframes kriya-jev-breathe {
      0%, 100% {
        box-shadow:
          0 0 0 2px rgba(167, 139, 250, 0.95),
          0 0 14px 3px rgba(192, 132, 252, 0.55),
          0 0 28px 8px rgba(196, 181, 253, 0.28);
      }
      50% {
        box-shadow:
          0 0 0 2px rgba(192, 132, 252, 1),
          0 0 22px 6px rgba(192, 132, 252, 0.85),
          0 0 48px 16px rgba(216, 180, 254, 0.55);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      #${GUIDE_HIGHLIGHT_ID} { transition: none; animation: none; }
    }
  `;
  document.head.appendChild(style);
}
