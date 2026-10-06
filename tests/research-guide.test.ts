import { createResearchGuide } from '../src/guide/ResearchGuide';
import { observePage, resetGuideCache } from '../src/guide/observe';
import { createTypeSafeDecider } from '../src/guide/typesafe';
import type { GuideDecideResult, GuideHttp, SystemOneRequest } from '../src/types';

function element(tag: string, text: string, top = 200): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  node.getBoundingClientRect = (): DOMRect =>
    ({
      x: 20,
      y: top,
      top,
      left: 20,
      right: 320,
      bottom: top + 40,
      width: 300,
      height: 40,
      toJSON: (): object => ({}),
    }) as DOMRect;
  document.body.append(node);
  return node;
}
function distribution(
  criteria: Readonly<Record<string, unknown>>,
  choice: string
): Record<string, number> {
  return Object.fromEntries(Object.keys(criteria).map(key => [key, key === choice ? 1 : 0]));
}
function target(request: SystemOneRequest, operation: string, text: string): string {
  return (
    Object.entries(request.questions[`${operation.toLowerCase()}_target`]?.criteria ?? {}).find(
      ([, value]) => typeof value === 'object' && value.element?.includes(text)
    )?.[0] ?? ''
  );
}
const execute = async (
  step: { operation?: string },
  node: HTMLElement | undefined
): Promise<void> => {
  if (step.operation === 'CLICK') node?.click();
};
const finishYes: GuideDecideResult = {
  ok: true,
  operation: 'DONE',
  confidence: 1,
  answer: 'YES',
  answerConfidence: 1,
};

describe('single-question Jev investigation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.history.replaceState(null, '', '/');
    resetGuideCache();
  });

  test('the model chooses navigation and evidence from one unchanged question, with no supplied destinations or quotes', async () => {
    const link = element('a', 'Help center');
    link.setAttribute('href', '/help');
    link.addEventListener('click', event => {
      event.preventDefault();
      window.history.pushState(null, '', '/help');
      document.body.innerHTML = '';
      element('h2', 'Invoices can be exported as CSV');
    });
    const goal = 'Does this service support exporting invoices?';
    const requests: SystemOneRequest[] = [];
    const http: GuideHttp = async (url, init) => {
      expect(url).toBe('https://api.typesafe.ai/v1/systemone');
      expect(init.headers.Authorization).toBe('Bearer fixture-key');
      const request = JSON.parse(init.body) as SystemOneRequest;
      requests.push(request);
      const operation =
        requests.length === 1 ? 'CLICK' : requests.length === 2 ? 'HIGHLIGHT' : 'DONE';
      const key = `${operation.toLowerCase()}_target`;
      const choice = target(
        request,
        operation,
        operation === 'CLICK' ? 'Help center' : 'Invoices can'
      );
      return {
        ok: true,
        status: 200,
        json: async (): Promise<unknown> => ({
          model: 'jev-fixture',
          answers: {
            operation: {
              choice: operation,
              confidence: 1,
              probabilities: distribution(request.questions.operation?.criteria ?? {}, operation),
            },
            ...(choice !== ''
              ? {
                  [key]: {
                    choice,
                    confidence: 1,
                    probabilities: distribution(request.questions[key]?.criteria ?? {}, choice),
                  },
                }
              : {}),
            ...(request.questions.answer !== undefined
              ? {
                  answer: {
                    choice: 'YES',
                    confidence: 1,
                    probabilities: distribution(request.questions.answer.criteria, 'YES'),
                  },
                }
              : {}),
          },
        }),
      };
    };
    const guide = createResearchGuide({ execute });
    const result = await guide.run(goal, createTypeSafeDecider({ apiKey: 'fixture-key', http }));
    expect(result).toMatchObject({ ok: true, answer: 'YES', steps: 3 });
    expect(result.evidence.map(item => item.text)).toEqual(['Invoices can be exported as CSV']);
    expect(requests.every(request => request.state.task === goal)).toBe(true);
    expect(requests.every(request => request.questions.operation?.instructions.goal === goal)).toBe(
      true
    );
    expect(requests.every(request => request.state.objective === undefined)).toBe(true);
    const instructions = requests
      .flatMap(request =>
        Object.values(request.questions).map(question => JSON.stringify(question.instructions))
      )
      .join(' ');
    expect(instructions).not.toContain('/help');
    expect(instructions).not.toContain('Invoices can be exported as CSV');
    expect(requests[0]?.questions.operation?.criteria).not.toHaveProperty('DONE');
    expect(requests[2]?.questions.operation?.criteria).toHaveProperty('DONE');
    expect(requests[2]?.state.evidence).toEqual(result.evidence);
    expect(requests[2]?.questions.answer?.instructions.question).toBe(goal);
  });

  test('Jev can finish after one selected passage without a required tour length', async () => {
    element('p', 'Recurring billing is supported');
    let calls = 0;
    const result = await createResearchGuide({ execute }).run(
      'Does the service support recurring billing?',
      async request => {
        calls += 1;
        return calls === 1
          ? {
              ok: true,
              operation: 'HIGHLIGHT',
              targetIndex: target(request, 'HIGHLIGHT', 'Recurring'),
              confidence: 1,
            }
          : finishYes;
      }
    );
    expect(result).toMatchObject({ ok: true, steps: 2, answer: 'YES' });
    expect(result.evidence).toHaveLength(1);
  });

  test('a confident negative answer cannot turn into success', async () => {
    element('p', 'Recurring billing is unavailable');
    let calls = 0;
    const result = await createResearchGuide({ execute }).run(
      'Does the service support recurring billing?',
      async request => {
        calls += 1;
        return calls === 1
          ? {
              ok: true,
              operation: 'HIGHLIGHT',
              targetIndex: target(request, 'HIGHLIGHT', 'Recurring'),
              confidence: 1,
            }
          : { ...finishYes, answer: 'NO' };
      }
    );
    expect(result).toMatchObject({ ok: false, answer: 'NO', status: 'failure' });
  });

  test('an undecided answer cannot turn into success even when Jev chooses DONE', async () => {
    element('p', 'Welcome to our service');
    let calls = 0;
    const result = await createResearchGuide({ execute }).run(
      'Does this service support invoicing?',
      async request => {
        calls += 1;
        return calls === 1
          ? {
              ok: true,
              operation: 'HIGHLIGHT',
              targetIndex: target(request, 'HIGHLIGHT', 'Welcome'),
              confidence: 1,
            }
          : { ...finishYes, answer: 'UNKNOWN' };
      }
    );
    expect(result).toMatchObject({ ok: false, answer: 'UNKNOWN' });
  });

  test('authentication failure cannot execute actions', async () => {
    element('p', 'Recurring billing is supported');
    const apply = jest.fn(async (): Promise<void> => {});
    const http: GuideHttp = async () => ({
      ok: false,
      status: 401,
      json: async (): Promise<unknown> => ({}),
    });
    const result = await createResearchGuide({ execute: apply }).run(
      'Does the service support billing?',
      createTypeSafeDecider({ apiKey: 'invalid-fixture', http })
    );
    expect(result).toMatchObject({ ok: false, error: 'TypeSafe returned HTTP 401' });
    expect(apply).not.toHaveBeenCalled();
  });

  test('cancellation prevents a late model decision from executing', async () => {
    element('p', 'Recurring billing is supported');
    let resolve: ((decision: GuideDecideResult) => void) | undefined;
    const pending = new Promise<GuideDecideResult>(done => {
      resolve = done;
    });
    const apply = jest.fn(async (): Promise<void> => {});
    const guide = createResearchGuide({ execute: apply });
    const running = guide.run('Does the service support billing?', () => pending);
    guide.stop();
    resolve?.({ ok: true, operation: 'HIGHLIGHT', targetIndex: '1', confidence: 1 });
    expect(await running).toMatchObject({ ok: false, status: 'cancelled' });
    expect(apply).not.toHaveBeenCalled();
  });

  test('an uncertain target is rejected even with a confident operation', async () => {
    element('p', 'Recurring billing is supported');
    const apply = jest.fn(async (): Promise<void> => {});
    const http: GuideHttp = async (_url, init) => {
      const request = JSON.parse(init.body) as SystemOneRequest;
      const choice = target(request, 'HIGHLIGHT', 'Recurring');
      return {
        ok: true,
        status: 200,
        json: async (): Promise<unknown> => ({
          answers: {
            operation: {
              choice: 'HIGHLIGHT',
              confidence: 1,
              probabilities: distribution(request.questions.operation?.criteria ?? {}, 'HIGHLIGHT'),
            },
            highlight_target: {
              choice,
              confidence: 0.1,
              probabilities: distribution(
                request.questions.highlight_target?.criteria ?? {},
                choice
              ),
            },
          },
        }),
      };
    };
    expect(
      await createResearchGuide({ execute: apply, minActionConfidence: 0.6 }).run(
        'Does the service support billing?',
        createTypeSafeDecider({ apiKey: 'fixture-key', http })
      )
    ).toMatchObject({ ok: false, error: 'Jev was not confident enough to continue' });
    expect(apply).not.toHaveBeenCalled();
  });

  test('hidden content and the guide bar are excluded while off-screen passages remain available', () => {
    const hidden = element('div', 'Hidden container');
    hidden.style.display = 'none';
    hidden.append(element('p', 'Hidden claim'));
    element('div', 'Success. Our claim is confirmed').dataset.kriyaGuide = 'bar';
    element('h2', 'Billing evidence below the fold', 2000);
    const observation = observePage({ includeText: true, includeOffscreen: true });
    expect(observation.elements.map(item => item.label)).toEqual([
      'Billing evidence below the fold',
    ]);
    expect(observation.text).not.toContain('Hidden claim');
    expect(observation.text).not.toContain('Our claim is confirmed');
  });

  test('neither an early DONE nor an unpermitted click can execute', async () => {
    element('p', 'Billing is supported');
    const apply = jest.fn(async (): Promise<void> => {});
    expect(
      await createResearchGuide({ execute: apply }).run(
        'Is billing supported?',
        async () => finishYes
      )
    ).toMatchObject({ ok: false, error: 'Jev chose an operation that was not offered' });
    document.body.innerHTML = '';
    element('button', 'Buy now');
    expect(
      (
        await createResearchGuide({ execute: apply }).run('Is billing supported?', async () => ({
          ok: true,
          operation: 'CLICK',
          targetIndex: '1',
          confidence: 1,
        }))
      ).ok
    ).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  test('visible text on a control is evidence without clicking or using its accessibility label', async () => {
    const category = element('button', 'Recurring billing');
    category.setAttribute('aria-label', 'Open settings');
    const click = jest.fn();
    category.addEventListener('click', click);
    let calls = 0;
    const result = await createResearchGuide({ execute }).run(
      'Is recurring billing offered?',
      async request => {
        calls += 1;
        return calls === 1
          ? {
              ok: true,
              operation: 'HIGHLIGHT',
              targetIndex: target(request, 'HIGHLIGHT', 'Recurring'),
              confidence: 1,
            }
          : finishYes;
      }
    );
    expect(result.evidence[0]?.text).toBe('Recurring billing');
    expect(click).not.toHaveBeenCalled();
  });

  test('linked headlines and full card text are available without clipping the selected evidence', () => {
    const card = element('a', '');
    card.setAttribute('href', '/news');
    card.append(element('h3', 'Billing has superpowers now'));
    card.append(
      element('p', 'A long description of billing features and the partnership. '.repeat(5))
    );
    const observation = observePage({ includeText: true, includeOffscreen: true });
    const link = observation.elements.find(item => item.role === 'link');
    expect(link?.operations).toContain('HIGHLIGHT');
    expect(link?.text).toBe(card.textContent?.replace(/\s+/g, ' ').trim());
    expect(observation.elements.some(item => item.label === 'Billing has superpowers now')).toBe(
      true
    );
  });

  test('already collected passages are removed from subsequent reading choices', async () => {
    element('p', 'Recurring billing is supported');
    element('p', 'Contact our support team');
    let calls = 0;
    const result = await createResearchGuide({ execute }).run(
      'Is recurring billing supported?',
      async request => {
        calls += 1;
        if (calls === 1)
          return {
            ok: true,
            operation: 'HIGHLIGHT',
            targetIndex: target(request, 'HIGHLIGHT', 'Recurring'),
            confidence: 1,
          };
        expect(target(request, 'HIGHLIGHT', 'Recurring')).toBe('');
        return finishYes;
      }
    );
    expect(result.ok).toBe(true);
  });

  test('an uncertain answer cannot bypass the final verdict gate', async () => {
    element('p', 'Recurring billing is supported');
    let calls = 0;
    const result = await createResearchGuide({ execute }).run(
      'Is recurring billing supported?',
      async request => {
        calls += 1;
        return calls === 1
          ? {
              ok: true,
              operation: 'HIGHLIGHT',
              targetIndex: target(request, 'HIGHLIGHT', 'Recurring'),
              confidence: 1,
            }
          : { ...finishYes, answerConfidence: 0.1 };
      }
    );
    expect(result).toMatchObject({ ok: false, answer: 'UNKNOWN' });
  });

  test('read-only exploration can proceed with uncertain action choices while the final answer stays confident', async () => {
    element('p', 'Recurring billing is supported');
    let calls = 0;
    const result = await createResearchGuide({ execute }).run(
      'Is recurring billing supported?',
      async request => {
        calls += 1;
        return calls === 1
          ? {
              ok: true,
              operation: 'HIGHLIGHT',
              targetIndex: target(request, 'HIGHLIGHT', 'Recurring'),
              confidence: 0.1,
            }
          : { ...finishYes, confidence: 0.2 };
      }
    );
    expect(result).toMatchObject({ ok: true, answer: 'YES', confidence: 1 });
  });

  test('navigation already tried from the same page is not offered again', async () => {
    const link = element('a', 'Help center');
    link.setAttribute('href', '/help');
    link.addEventListener('click', event => event.preventDefault());
    element('p', 'Recurring billing is supported');
    let calls = 0;
    const result = await createResearchGuide({ execute }).run(
      'Is recurring billing supported?',
      async request => {
        calls += 1;
        if (calls === 1)
          return {
            ok: true,
            operation: 'CLICK',
            targetIndex: target(request, 'CLICK', 'Help center'),
            confidence: 1,
          };
        if (calls === 2) {
          expect(target(request, 'CLICK', 'Help center')).toBe('');
          return {
            ok: true,
            operation: 'HIGHLIGHT',
            targetIndex: target(request, 'HIGHLIGHT', 'Recurring'),
            confidence: 1,
          };
        }
        return finishYes;
      }
    );
    expect(result.ok).toBe(true);
  });
});
