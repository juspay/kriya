import { GUIDE_HIGHLIGHT_ID, GUIDE_STATUS_ID } from '../src/guide/highlight';
import { createClickGuide } from '../src/guide/ClickGuide';
import { JEV_BAR_ID, mountJevGuide } from '../src/guide/surface';
import { buildGuideRequest } from '../src/guide/request';
import { observePage, resetGuideCache } from '../src/guide/observe';
import { createTypeSafeDecider } from '../src/guide/typesafe';
import type { GuideDecider, GuideHttp } from '../src/guide/types';

function place(element: HTMLElement, top: number): HTMLElement {
  element.getBoundingClientRect = (): DOMRect =>
    ({
      x: 10,
      y: top,
      top,
      left: 10,
      right: 130,
      bottom: top + 32,
      width: 120,
      height: 32,
      toJSON: (): object => ({}),
    }) as DOMRect;
  document.body.appendChild(element);
  return element;
}

function button(label: string, top: number): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  return place(element, top) as HTMLButtonElement;
}

describe('click guide', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetGuideCache();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    resetGuideCache();
  });

  test('observation keeps visible controls and drops hidden and password fields', () => {
    button('Settings', 20);
    const hidden = document.createElement('button');
    hidden.textContent = 'Hidden';
    hidden.style.display = 'none';
    place(hidden, 80);
    const secret = document.createElement('input');
    secret.type = 'password';
    secret.setAttribute('aria-label', 'Password');
    place(secret, 120);

    const observation = observePage();
    const labels = observation.elements.map(element => element.label);

    expect(labels).toContain('Settings');
    expect(labels).not.toContain('Hidden');
    expect(labels).not.toContain('Password');
    expect(observation.controls.map(control => control.operation)).toContain('WAIT');
  });

  test('the request offers only the controls on the page', () => {
    button('Settings', 20);
    button('Help', 60);
    const observation = observePage();
    const request = buildGuideRequest(
      observation,
      'turn off email notifications',
      [],
      'jev-latest'
    );
    const clickTargets = request.questions.click_target?.criteria ?? {};

    expect(request.state.task).toBe('turn off email notifications');
    expect(request.questions.operation?.criteria).toMatchObject({
      CLICK: expect.any(String) as unknown,
      DONE: expect.any(String) as unknown,
      BLOCKED: expect.any(String) as unknown,
    });
    expect(Object.values(clickTargets).map(criterion => criterionValue(criterion))).toEqual([
      '[1] Settings',
      '[2] Help',
    ]);
  });

  test('start outlines the control the decider picks', async () => {
    button('Avatar', 20);
    button('Settings', 60);
    const guide = createClickGuide({ autoContinue: false });
    const decide: GuideDecider = request => {
      const clickTargets = request.questions.click_target?.criteria ?? {};
      const settings = Object.entries(clickTargets).find(([, criterion]) =>
        criterionValue(criterion).includes('Settings')
      );
      return Promise.resolve({
        ok: true,
        operation: 'CLICK',
        targetIndex: settings?.[0] ?? '2',
        confidence: 0.8,
      });
    };

    const result = await guide.start('turn off email notifications', decide);
    const box = document.getElementById(GUIDE_HIGHLIGHT_ID);
    const status = document.getElementById(GUIDE_STATUS_ID);

    expect(result.ok).toBe(true);
    expect(result.label).toBe('Settings');
    expect(box?.style.top).toBe('54px');
    expect(status?.querySelector('[data-kriya-guide="goal"]')?.textContent).toBe(
      'turn off email notifications'
    );
    guide.stop();
    expect(document.getElementById(GUIDE_HIGHLIGHT_ID)).toBeNull();
  });

  test('clicking the outline asks again after the page changes', async () => {
    const avatar = button('Avatar', 20);
    const calls: string[] = [];
    const decide: GuideDecider = request => {
      calls.push(request.state.recentActions.map(entry => entry.action).join(','));
      if (calls.length === 1) {
        return Promise.resolve({ ok: true, operation: 'CLICK', targetIndex: '1', confidence: 1 });
      }
      const clickTargets = request.questions.click_target?.criteria ?? {};
      const settings = Object.keys(clickTargets)[0] ?? '1';
      return Promise.resolve({
        ok: true,
        operation: 'CLICK',
        targetIndex: settings,
        confidence: 1,
      });
    };
    const guide = createClickGuide();

    await guide.start('turn off email notifications', decide);
    avatar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    avatar.remove();
    button('Settings', 60);
    await jest.advanceTimersByTimeAsync(50);

    expect(calls).toEqual(['', 'Avatar']);
    expect(document.getElementById(GUIDE_HIGHLIGHT_ID)?.style.top).toBe('54px');
    guide.dispose();
  });

  test('a click away from the outline does not ask again', async () => {
    button('Avatar', 20);
    const other = button('Help', 60);
    let calls = 0;
    const decide: GuideDecider = () => {
      calls += 1;
      return Promise.resolve({ ok: true, operation: 'CLICK', targetIndex: '1', confidence: 1 });
    };
    const guide = createClickGuide();

    await guide.start('open settings', decide);
    other.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await jest.advanceTimersByTimeAsync(50);

    expect(calls).toBe(1);
    guide.dispose();
  });

  test('an unknown target leaves the page unmarked', async () => {
    button('Avatar', 20);
    const guide = createClickGuide({ autoContinue: false });
    const result = await guide.start('open settings', () =>
      Promise.resolve({ ok: true, operation: 'CLICK', targetIndex: '99', confidence: 1 })
    );

    expect(result.ok).toBe(false);
    expect(document.getElementById(GUIDE_HIGHLIGHT_ID)).toBeNull();
  });

  test('the TypeSafe adapter accepts a calibrated choice and rejects a bad one', async () => {
    button('Settings', 20);
    const observation = observePage();
    const request = buildGuideRequest(observation, 'open settings', [], 'jev-latest');
    const operationKeys = Object.keys(request.questions.operation?.criteria ?? {});
    const targetKeys = Object.keys(request.questions.click_target?.criteria ?? {});
    const http: GuideHttp = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: (): Promise<unknown> =>
          Promise.resolve({
            answers: {
              operation: {
                choice: 'CLICK',
                confidence: 0.9,
                probabilities: distribution(operationKeys, 'CLICK'),
              },
              click_target: {
                choice: targetKeys[0],
                confidence: 0.8,
                probabilities: distribution(targetKeys, targetKeys[0] ?? ''),
              },
            },
          }),
      });
    const decide = createTypeSafeDecider({ apiKey: 'test-key', http });
    const result = await decide(request);

    expect(result).toMatchObject({ ok: true, operation: 'CLICK', targetIndex: '1' });

    const rejected = createTypeSafeDecider({
      apiKey: 'test-key',
      http: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: (): Promise<unknown> =>
            Promise.resolve({
              answers: {
                operation: { choice: 'CLICK', confidence: 0.4, probabilities: { CLICK: 0.4 } },
              },
            }),
        }),
    });
    const bad = await rejected(request);
    expect(bad.ok).toBe(false);
  });

  test('the Jev bar outlines the next control and hides its own chrome', async () => {
    button('Settings', 40);
    const session = mountJevGuide({
      decider: request => {
        const criteria = request.questions.click_target?.criteria ?? {};
        const labels = Object.values(criteria).map(criterionValue).join(' ');
        expect(labels).not.toContain('Next');
        const targetIndex = Object.keys(criteria)[0] ?? '1';
        return Promise.resolve({ ok: true, operation: 'CLICK', targetIndex, confidence: 1 });
      },
    });

    const result = await session.submit('open settings');

    expect(result.ok).toBe(true);
    expect(result.label).toBe('Settings');
    expect(document.getElementById(JEV_BAR_ID)).not.toBeNull();
    expect(document.querySelector('[data-kriya-guide="pace"]')?.textContent).toContain('Guide');
    session.close();
    expect(document.getElementById(JEV_BAR_ID)).toBeNull();
    expect(document.getElementById(GUIDE_HIGHLIGHT_ID)).toBeNull();
  });
});

function criterionValue(criterion: string | Readonly<Record<string, string>>): string {
  return typeof criterion === 'string' ? criterion : (criterion.element ?? '');
}

function distribution(keys: readonly string[], winner: string): Record<string, number> {
  const probabilities: Record<string, number> = {};
  for (const key of keys) {
    probabilities[key] = key === winner ? 1 : 0;
  }
  return probabilities;
}
