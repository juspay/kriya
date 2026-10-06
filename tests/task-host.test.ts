import { randomBytes } from 'crypto';
import { createAutomationTaskHost } from '@/agent/browser/AutomationTaskHost';
import { toActionCommand } from '@/agent/commands';
import { validateActionParameters } from '@/actions/parameters';
import { AutomationEngine } from '@/core/AutomationEngine';
import { createRedactor } from '@/utils/redact';
import { TASK_BRIDGE_PROTOCOL, TASK_HOST_OPERATIONS, TASK_REDACTED } from '@/types';
import type {
  AutomationTaskHostConfig,
  ExecutionResult,
  TaskActionExecutor,
  TaskCommandRequest,
  TaskElement,
  TaskExecutionOutcome,
  TaskHost,
  TaskHostCommand,
  TaskObservation,
  TaskTargetRef,
} from '@/types';
import { counterIds, makeCommandRequest, makeHostCommand } from './helpers/agent-fixtures';
import {
  installLayoutStubs,
  makeScrollable,
  mountHtml,
  resetDom,
  setBox,
  setViewport,
} from './helpers/domHarness';

const hosts: TaskHost[] = [];
const engines: AutomationEngine[] = [];
function engine(): AutomationEngine {
  const result = new AutomationEngine({
    debugMode: false,
    screenshotOnError: false,
    contextCaptureEnabled: false,
    formDetectionEnabled: false,
    redactor: createRedactor(),
  });
  result.initialize();
  engines.push(result);
  return result;
}
function host(config: Partial<AutomationTaskHostConfig<HTMLElement>> = {}): TaskHost {
  const result = createAutomationTaskHost({
    executor: config.executor ?? engine(),
    createId: counterIds(),
    settle: { quietMs: 0, maxMs: 10 },
    ...config,
  });
  hosts.push(result);
  return result;
}
async function observe(target: TaskHost, sessionId = 'ses_test'): Promise<TaskObservation> {
  const result = await target.observe({ sessionId });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error('Expected an observation.');
  }
  return result.value;
}
function element(observation: TaskObservation, label: string): TaskElement {
  const result = observation.elements.find(item => item.label === label);
  expect(result).toBeDefined();
  if (!result) {
    throw new Error('Expected an observed element.');
  }
  return result;
}
function ref(observation: TaskObservation, label: string): TaskTargetRef {
  const entry = element(observation, label);
  return {
    sessionId: observation.sessionId,
    snapshotId: observation.snapshotId,
    targetId: entry.id,
    signature: entry.signature,
  };
}
function request(
  observation: TaskObservation,
  command: TaskHostCommand,
  overrides: Partial<TaskCommandRequest> = {}
): TaskCommandRequest {
  return makeCommandRequest({
    scope: {
      sessionId: observation.sessionId,
      snapshotId: observation.snapshotId,
      documentId: observation.documentId,
    },
    command,
    allowedOrigins: [window.location.origin],
    timeoutMs: 1000,
    settle: { quietMs: 0, maxMs: 10 },
    ...overrides,
  });
}
function execution(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    success: true,
    status: 'completed',
    timestamp: Date.now(),
    effect: 'applied',
    ...overrides,
  };
}

beforeEach(() => {
  resetDom();
  installLayoutStubs();
  setViewport({ width: 1000, height: 900, scrollHeight: 1800 });
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(target => target.dispose()));
  engines.splice(0).forEach(target => target.dispose());
  jest.restoreAllMocks();
  resetDom();
});

describe('real engine host integration', () => {
  test('capabilities accurately identify in-page lifetime and restricted operations', async () => {
    mountHtml('<button>Act</button><p>Evidence</p>');
    const target = host({ operations: ['READ'] });
    const result = await target.capabilities();
    expect(result).toMatchObject({
      ok: true,
      value: {
        hostKind: 'in_page',
        protocol: TASK_BRIDGE_PROTOCOL,
        persistsAcrossNavigation: false,
        detectsNavigation: true,
        strictTargets: true,
        authoritativeLocation: false,
        operations: ['READ'],
        waitDurationsMs: [],
      },
    });
    const snapshot = await observe(target);
    expect(element(snapshot, 'Act').operations).toEqual(['READ']);
    expect(
      await target.execute(request(snapshot, { operation: 'CLICK', target: ref(snapshot, 'Act') }))
    ).toMatchObject({ status: 'rejected_scope', effect: 'none', code: 'PERMISSION_DENIED' });
  });

  test('READ reads sanitized current text without invoking the engine', async () => {
    const root = mountHtml(
      '<p aria-label="Evidence">Observed [t1]\u200b <span data-kriya-sensitive>private-content</span></p>'
    );
    const executor = engine();
    const spy = jest.spyOn(executor, 'executeAction');
    const target = host({ executor });
    const snapshot = await observe(target);
    (root.querySelector('p') as HTMLElement).firstChild!.textContent = 'Updated [t2]\u200b ';
    const output = await target.execute(
      request(snapshot, { operation: 'READ', target: ref(snapshot, 'Evidence') })
    );
    expect(output).toMatchObject({
      status: 'applied',
      effect: 'none',
      readback: { kind: 'read', text: 'Updated (t2)' },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  test('FILL executes only the selected target including a clear-field command', async () => {
    const root = mountHtml('<input aria-label="First"><input aria-label="Second">');
    const target = host();
    const first = await observe(target);
    const output = await target.execute(
      request(first, {
        operation: 'FILL',
        target: ref(first, 'Second'),
        value: 'Requested',
        sensitive: false,
      })
    );
    expect(output).toMatchObject({
      status: 'applied',
      effect: 'applied',
      readback: { kind: 'fill', matched: true },
    });
    expect((root.querySelectorAll('input')[0] as HTMLInputElement).value).toBe('');
    expect((root.querySelectorAll('input')[1] as HTMLInputElement).value).toBe('Requested');
    const next = await observe(target);
    const clear = await target.execute(
      request(next, { operation: 'FILL', target: ref(next, 'Second'), value: '', sensitive: false })
    );
    expect(clear).toMatchObject({
      status: 'applied',
      effect: 'applied',
      readback: { kind: 'fill', empty: true, matched: true },
    });
  });

  test('native fill checked and selected state report idempotent no-ops', async () => {
    mountHtml(
      '<input aria-label="Name" value="Existing"><input type="checkbox" checked aria-label="Agree"><select aria-label="Size"><option>Small</option><option selected>Large</option></select>'
    );
    const target = host();
    const snapshot = await observe(target);
    const commands: TaskHostCommand[] = [
      { operation: 'FILL', target: ref(snapshot, 'Name'), value: 'Existing', sensitive: false },
      { operation: 'SET_CHECKED', target: ref(snapshot, 'Agree'), checked: true },
      {
        operation: 'SELECT',
        target: ref(snapshot, 'Size'),
        optionId: element(snapshot, 'Size').options?.[1]?.id,
      },
    ];
    for (const command of commands) {
      expect(await target.execute(request(snapshot, command))).toMatchObject({
        status: 'noop_already_satisfied',
        effect: 'none',
        readback: { changed: false, matched: true },
      });
    }
  });

  test('SELECT uses the option id and SET_CHECKED resolves visible labels', async () => {
    const root = mountHtml(
      '<select aria-label="Size"><option value="s">Small</option><option value="l">Large</option></select><input type="checkbox" id="agree"><label for="agree">Agree</label>'
    );
    const input = root.querySelector('input') as HTMLInputElement;
    setBox(input, { top: 70, width: 0, height: 0 });
    setBox(root.querySelector('label') as HTMLElement, { top: 70 });
    const target = host();
    const snapshot = await observe(target);
    const select = await target.execute(
      request(snapshot, {
        operation: 'SELECT',
        target: ref(snapshot, 'Size'),
        optionId: element(snapshot, 'Size').options?.[1]?.id,
      })
    );
    expect(select).toMatchObject({
      status: 'applied',
      effect: 'applied',
      readback: { kind: 'select', index: 1, matched: true },
    });
    expect((root.querySelector('select') as HTMLSelectElement).value).toBe('l');
    const checked = await target.execute(
      request(snapshot, { operation: 'SET_CHECKED', target: ref(snapshot, 'Agree'), checked: true })
    );
    expect(checked).toMatchObject({
      status: 'applied',
      effect: 'applied',
      readback: { kind: 'setChecked', after: true, matched: true },
    });
    expect(input.checked).toBe(true);
  });

  test('ARIA option selection and checked state use real engine actions', async () => {
    const root = mountHtml(
      '<div role="listbox"><div role="option" aria-selected="false">Choice</div></div><div role="switch" aria-checked="false" aria-label="Light"></div>'
    );
    const option = root.querySelector('[role=option]') as HTMLElement;
    option.addEventListener('click', () => option.setAttribute('aria-selected', 'true'));
    const toggle = root.querySelector('[role=switch]') as HTMLElement;
    toggle.addEventListener('click', () => toggle.setAttribute('aria-checked', 'true'));
    const target = host();
    const first = await observe(target);
    expect(
      await target.execute(request(first, { operation: 'SELECT', target: ref(first, 'Choice') }))
    ).toMatchObject({
      status: 'applied',
      effect: 'applied',
      readback: { kind: 'select', control: 'aria', matched: true },
    });
    const next = await observe(target);
    expect(
      await target.execute(
        request(next, { operation: 'SET_CHECKED', target: ref(next, 'Light'), checked: true })
      )
    ).toMatchObject({
      status: 'applied',
      effect: 'applied',
      readback: { kind: 'setChecked', control: 'aria', matched: true },
    });
  });

  test('SCROLL supports page and containers and reports edges', async () => {
    const root = mountHtml('<div id="scroll" style="overflow-y:auto">Container</div>');
    const container = root.querySelector('#scroll') as HTMLElement;
    setBox(container, { top: 10, height: 100 });
    makeScrollable(container, { clientHeight: 100, scrollHeight: 400 });
    const target = host();
    const snapshot = await observe(target);
    expect(
      await target.execute(request(snapshot, { operation: 'SCROLL', direction: 'TOP' }))
    ).toMatchObject({ status: 'noop_already_satisfied', effect: 'none' });
    expect(
      await target.execute(request(snapshot, { operation: 'SCROLL', direction: 'BOTTOM' }))
    ).toMatchObject({
      status: 'applied',
      effect: 'applied',
      readback: { kind: 'scroll', moved: true, after: 900 },
    });
    expect(
      await target.execute(
        request(snapshot, {
          operation: 'SCROLL',
          target: ref(snapshot, 'Container'),
          direction: 'BOTTOM',
        })
      )
    ).toMatchObject({
      status: 'applied',
      effect: 'applied',
      readback: { kind: 'scroll', after: 300 },
    });
  });

  test('SUBMIT and PRESS Enter share native form submission behavior', async () => {
    const root = mountHtml(
      '<form action="/save"><input aria-label="Name" value="Ada"><button>Save</button></form>'
    );
    let submissions = 0;
    root.querySelector('form')?.addEventListener('submit', event => {
      event.preventDefault();
      submissions += 1;
    });
    const target = host();
    const snapshot = await observe(target);
    const submit = await target.execute(
      request(snapshot, { operation: 'SUBMIT', target: ref(snapshot, 'Save') })
    );
    expect(submit).toMatchObject({
      status: 'applied',
      effect: 'applied',
      readback: { kind: 'click', submit: { event: true, invalidControls: 0 } },
    });
    const press = await target.execute(
      request(snapshot, { operation: 'PRESS', target: ref(snapshot, 'Name'), key: 'Enter' })
    );
    expect(press).toMatchObject({
      status: 'applied',
      effect: 'applied',
      readback: { kind: 'press', defaultAction: 'implicit_submit', submit: { event: true } },
    });
    expect(submissions).toBe(2);
  });

  test('native validation failure reports the click effect without claiming submission', async () => {
    mountHtml(
      '<form action="/save"><input required aria-label="Name"><button>Save</button></form>'
    );
    const target = host();
    const snapshot = await observe(target);
    expect(
      await target.execute(
        request(snapshot, { operation: 'SUBMIT', target: ref(snapshot, 'Save') })
      )
    ).toMatchObject({
      status: 'failed',
      effect: 'applied',
      code: 'VALIDATION_FAILED',
      readback: { kind: 'click', submit: { event: false, invalidControls: 1 } },
    });
  });

  test('post-settle readback catches an asynchronous field overwrite', async () => {
    const root = mountHtml('<input aria-label="Name">');
    const input = root.querySelector('input') as HTMLInputElement;
    input.addEventListener('input', () => {
      setTimeout(() => {
        input.value = 'Overwritten';
      }, 0);
    });
    const target = host();
    const snapshot = await observe(target);
    const result = await target.execute(
      request(
        snapshot,
        { operation: 'FILL', target: ref(snapshot, 'Name'), value: 'Requested', sensitive: false },
        { settle: { quietMs: 20, maxMs: 60 } }
      )
    );
    expect(result).toMatchObject({
      status: 'failed',
      effect: 'applied',
      code: 'READBACK_MISMATCH',
      readback: { kind: 'fill', matched: false },
    });
  });

  test('SPA navigation is detected after settling and every navigation URL is scrubbed', async () => {
    const root = mountHtml('<button>Move</button>');
    root
      .querySelector('button')
      ?.addEventListener('click', () =>
        window.history.pushState(null, '', '/next?token=private-value#fragment')
      );
    const target = host();
    const snapshot = await observe(target);
    const result = await target.execute(
      request(snapshot, { operation: 'CLICK', target: ref(snapshot, 'Move') })
    );
    expect(result).toMatchObject({
      status: 'navigated',
      effect: 'applied',
      navigation: {
        kind: 'same_document',
        realmLost: false,
        fromDocumentId: snapshot.documentId,
        toDocumentId: snapshot.documentId,
      },
    });
    expect(result.navigation?.toUrl).not.toContain('private-value');
    expect(result.navigation?.toUrl).not.toContain('#');
  });
});

describe('freshness and scope before engine invocation', () => {
  test.each(['document', 'targetScope', 'superseded', 'detached', 'structure', 'url'] as const)(
    'rejects stale or invalid target scope: %s',
    async kind => {
      const root = mountHtml('<button>Act</button>');
      const executor = engine();
      const spy = jest.spyOn(executor, 'executeAction');
      const target = host({ executor });
      const snapshot = await observe(target);
      let call = request(snapshot, { operation: 'CLICK', target: ref(snapshot, 'Act') });
      if (kind === 'document') {
        call = { ...call, scope: { ...call.scope, documentId: 'doc_other' } };
      }
      if (kind === 'targetScope') {
        call = { ...call, scope: { ...call.scope, sessionId: 'ses_other' } };
      }
      if (kind === 'superseded') {
        await observe(target);
      }
      if (kind === 'detached') {
        root.querySelector('button')?.remove();
      }
      if (kind === 'structure') {
        root.querySelector('button')?.setAttribute('data-kriya-commit', 'purchase');
      }
      if (kind === 'url') {
        window.history.pushState(null, '', '/spa');
      }
      const result = await target.execute(call);
      const reasons = {
        document: 'document_changed',
        superseded: 'superseded_snapshot',
        detached: 'element_detached',
        structure: 'structure_changed',
        url: 'url_changed',
      } as const;
      expect(result.status).toBe(kind === 'targetScope' ? 'rejected_invalid' : 'rejected_stale');
      if (kind !== 'targetScope') {
        expect(result.staleReason).toBe(reasons[kind]);
      }
      expect(result.effect).toBe('none');
      expect(spy).not.toHaveBeenCalled();
    }
  );

  test.each(['javascript:alert(1)', 'https://foreign.example/next'] as const)(
    'rejects unauthorized observed href: %s',
    async href => {
      mountHtml(`<a href="${href}">Next</a>`);
      const executor = engine();
      const spy = jest.spyOn(executor, 'executeAction');
      const target = host({ executor });
      const snapshot = await observe(target);
      expect(
        await target.execute(
          request(snapshot, { operation: 'NAVIGATE', target: ref(snapshot, 'Next') })
        )
      ).toMatchObject({ status: 'rejected_scope', effect: 'none', code: 'PERMISSION_DENIED' });
      expect(spy).not.toHaveBeenCalled();
    }
  );

  test('enforces document origin and form action scope before sending a fill', async () => {
    mountHtml(
      '<form action="https://foreign.example/save"><input aria-label="Name"><button>Save</button></form>'
    );
    const executor = engine();
    const spy = jest.spyOn(executor, 'executeAction');
    const target = host({ executor });
    const snapshot = await observe(target);
    const command = makeHostCommand('FILL', { target: ref(snapshot, 'Name') });
    expect(await target.execute(request(snapshot, command))).toMatchObject({
      status: 'rejected_scope',
      effect: 'none',
    });
    expect(
      await target.execute(
        request(snapshot, command, { allowedOrigins: ['https://foreign.example'] })
      )
    ).toMatchObject({ status: 'rejected_scope', effect: 'none' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('allows an explicitly authorized cross-origin link and intersects an install ceiling', async () => {
    const root = mountHtml('<a href="https://checkout.example/next">Next</a>');
    root.querySelector('a')?.addEventListener('click', event => event.preventDefault());
    const executor = engine();
    const spy = jest.spyOn(executor, 'executeAction');
    const target = host({ executor });
    const snapshot = await observe(target);
    const allowedOrigins = [window.location.origin, 'https://checkout.example'];
    expect(
      await target.execute(
        request(
          snapshot,
          { operation: 'NAVIGATE', target: ref(snapshot, 'Next') },
          { allowedOrigins }
        )
      )
    ).toMatchObject({ status: 'applied', effect: 'applied' });
    expect(spy).toHaveBeenCalledTimes(1);
    const constrained = host({ executor, allowedOrigins: [window.location.origin] });
    const constrainedSnapshot = await observe(constrained);
    expect(
      await constrained.execute(
        request(
          constrainedSnapshot,
          { operation: 'NAVIGATE', target: ref(constrainedSnapshot, 'Next') },
          { allowedOrigins }
        )
      )
    ).toMatchObject({ status: 'rejected_scope', effect: 'none' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test.each(['label', 'value', 'disabled'] as const)(
    'rejects changed select option metadata: %s',
    async change => {
      const root = mountHtml(
        '<select aria-label="Size"><option value="s">Small</option><option value="l">Large</option></select>'
      );
      const executor = engine();
      const spy = jest.spyOn(executor, 'executeAction');
      const target = host({ executor });
      const snapshot = await observe(target);
      const option = root.querySelectorAll('option')[1] as HTMLOptionElement;
      if (change === 'label') {
        option.label = 'Changed';
      }
      if (change === 'value') {
        option.value = 'Changed';
      }
      if (change === 'disabled') {
        option.disabled = true;
      }
      const result = await target.execute(
        request(snapshot, {
          operation: 'SELECT',
          target: ref(snapshot, 'Size'),
          optionId: element(snapshot, 'Size').options?.[1]?.id,
        })
      );
      expect(result).toMatchObject({
        status: 'rejected_stale',
        effect: 'none',
        staleReason: 'option_changed',
      });
      expect(spy).not.toHaveBeenCalled();
    }
  );

  test('sensitive READ and unoffered target operations are rejected before execution', async () => {
    mountHtml('<input type="password" aria-label="Password"><button>Act</button>');
    const executor = engine();
    const spy = jest.spyOn(executor, 'executeAction');
    const target = host({ executor });
    const snapshot = await observe(target);
    expect(
      await target.execute(
        request(snapshot, { operation: 'READ', target: ref(snapshot, 'Password') })
      )
    ).toMatchObject({ status: 'rejected_invalid', effect: 'none', code: 'VALIDATION_FAILED' });
    expect(
      await target.execute(request(snapshot, { operation: 'SUBMIT', target: ref(snapshot, 'Act') }))
    ).toMatchObject({ status: 'rejected_invalid', effect: 'none' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('radio name changes cannot execute against a different group', async () => {
    const root = mountHtml('<input type="radio" name="first" aria-label="Choice">');
    const executor = engine();
    const spy = jest.spyOn(executor, 'executeAction');
    const target = host({ executor });
    const snapshot = await observe(target);
    (root.querySelector('input') as HTMLInputElement).name = 'second';
    expect(
      await target.execute(
        request(snapshot, {
          operation: 'SET_CHECKED',
          target: ref(snapshot, 'Choice'),
          checked: true,
        })
      )
    ).toMatchObject({ status: 'rejected_stale', effect: 'none', staleReason: 'structure_changed' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('relative allowlist entries do not create an implicit document-origin grant', async () => {
    mountHtml('<input aria-label="Name">');
    const executor = engine();
    const spy = jest.spyOn(executor, 'executeAction');
    const target = host({ executor });
    const snapshot = await observe(target);
    expect(
      await target.execute(
        request(
          snapshot,
          {
            operation: 'FILL',
            target: ref(snapshot, 'Name'),
            value: 'Requested',
            sensitive: false,
          },
          { allowedOrigins: ['/'] }
        )
      )
    ).toMatchObject({ status: 'rejected_scope', effect: 'none' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('release and dispose invalidate targets and reject future calls', async () => {
    mountHtml('<button>Act</button>');
    const target = host();
    const snapshot = await observe(target);
    await target.release?.(snapshot.sessionId);
    expect(
      await target.execute(request(snapshot, { operation: 'CLICK', target: ref(snapshot, 'Act') }))
    ).toMatchObject({ status: 'rejected_stale', effect: 'none', staleReason: 'session_released' });
    await target.dispose();
    expect(
      await target.execute(request(snapshot, { operation: 'CLICK', target: ref(snapshot, 'Act') }))
    ).toMatchObject({ status: 'failed', effect: 'none', code: 'HOST_DISPOSED' });
    expect(await target.observe({ sessionId: 'ses_test' })).toMatchObject({
      ok: false,
      error: { code: 'HOST_DISPOSED' },
    });
    expect(await target.capabilities()).toMatchObject({
      ok: false,
      error: { code: 'HOST_DISPOSED' },
    });
  });
});

describe('compiler to strict executor seam', () => {
  test('every executable operation emits valid strict parameters and forwards the original signal', async () => {
    const root = mountHtml(
      '<button>Act</button><a href="/next">Next</a><form action="/save"><input aria-label="Name"><button>Save</button></form><input type="checkbox" aria-label="Agree"><select aria-label="Size"><option>Small</option></select><div role="listbox"><div role="option" aria-selected="false">Choice</div></div>'
    );
    root.querySelector('a')?.addEventListener('click', event => event.preventDefault());
    root.querySelector('form')?.addEventListener('submit', event => event.preventDefault());
    const calls: {
      type: string;
      valid: boolean;
      strict: boolean;
      signalSame: boolean;
      targetCorrect: boolean;
      sensitive: boolean;
    }[] = [];
    const controller = new AbortController();
    const executor = engine();
    const target = host({
      executor: {
        executeAction: async (action, options) => {
          calls.push({
            type: action.type,
            valid: validateActionParameters(action, true) === null,
            strict: options?.strict === true,
            signalSame: options?.signal === controller.signal,
            targetCorrect:
              options?.target !== undefined || ['scroll', 'wait'].includes(action.type),
            sensitive: action.sensitiveParameters?.includes('value') ?? false,
          });
          return executor.executeAction(action, options);
        },
      },
    });
    const snapshot = await observe(target);
    const commands: TaskHostCommand[] = [
      { operation: 'CLICK', target: ref(snapshot, 'Act') },
      { operation: 'NAVIGATE', target: ref(snapshot, 'Next') },
      { operation: 'SUBMIT', target: ref(snapshot, 'Save') },
      { operation: 'FILL', target: ref(snapshot, 'Name'), value: 'Requested', sensitive: false },
      {
        operation: 'SELECT',
        target: ref(snapshot, 'Size'),
        optionId: element(snapshot, 'Size').options?.[0]?.id,
      },
      { operation: 'SELECT', target: ref(snapshot, 'Choice') },
      { operation: 'SET_CHECKED', target: ref(snapshot, 'Agree'), checked: true },
      { operation: 'PRESS', target: ref(snapshot, 'Name'), key: 'Tab' },
      { operation: 'SCROLL', direction: 'TOP' },
      { operation: 'WAIT', durationMs: 250 },
    ];
    for (const command of commands) {
      const result = await target.execute(request(snapshot, command), controller.signal);
      expect(['rejected_invalid', 'rejected_scope', 'rejected_stale']).not.toContain(result.status);
    }
    expect(calls).toHaveLength(commands.length);
    expect(
      calls.every(call => call.valid && call.strict && call.signalSame && call.targetCorrect)
    ).toBe(true);
    expect(calls.map(call => call.type)).toEqual([
      'click',
      'click',
      'click',
      'fill',
      'select',
      'select',
      'setChecked',
      'press',
      'scroll',
      'wait',
    ]);
    expect(
      toActionCommand({ operation: 'READ', target: ref(snapshot, 'Act') }, { timeoutMs: 1000 })
    ).toBeNull();
  });
});

describe('custom executor result mapping (fault injection)', () => {
  const mappingRows: readonly {
    label: string;
    result: Partial<ExecutionResult>;
    expected: Partial<TaskExecutionOutcome>;
  }[] = [
    {
      label: 'success with absent effect',
      result: { effect: undefined },
      expected: { status: 'applied', effect: 'applied' },
    },
    {
      label: 'success with effect none',
      result: { effect: 'none' },
      expected: { status: 'applied', effect: 'none' },
    },
    {
      label: 'success with uncertain effect',
      result: { effect: 'uncertain' },
      expected: { status: 'uncertain', effect: 'uncertain' },
    },
    {
      label: 'matched no-op',
      result: {
        effect: 'none',
        data: {
          kind: 'fill',
          tag: 'input',
          inputType: 'text',
          changed: false,
          matched: true,
          length: 0,
          empty: true,
        },
      },
      expected: { status: 'noop_already_satisfied', effect: 'none' },
    },
    {
      label: 'edge scroll',
      result: {
        effect: 'none',
        data: {
          kind: 'scroll',
          moved: false,
          reason: 'edge',
          before: 0,
          after: 0,
          max: 0,
          atTop: true,
          atBottom: true,
        },
      },
      expected: { status: 'noop_already_satisfied', effect: 'none' },
    },
    {
      label: 'blocked scroll',
      result: {
        effect: 'none',
        data: {
          kind: 'scroll',
          moved: false,
          reason: 'blocked',
          before: 0,
          after: 0,
          max: 100,
          atTop: true,
          atBottom: false,
        },
      },
      expected: { status: 'failed', effect: 'none', code: 'UNSUPPORTED_STATE' },
    },
    {
      label: 'readback mismatch',
      result: {
        data: {
          kind: 'fill',
          tag: 'input',
          inputType: 'text',
          changed: true,
          matched: false,
          length: 0,
          empty: true,
        },
      },
      expected: { status: 'failed', effect: 'applied', code: 'READBACK_MISMATCH' },
    },
    {
      label: 'native validation',
      result: {
        data: {
          kind: 'click',
          defaultPrevented: false,
          submit: { event: false, invalidControls: 1, defaultPrevented: false },
        },
      },
      expected: { status: 'failed', effect: 'applied', code: 'VALIDATION_FAILED' },
    },
    {
      label: 'stale target failure',
      result: { success: false, status: 'failed', effect: 'none', errorCode: 'TARGET_STALE' },
      expected: { status: 'rejected_stale', effect: 'none', staleReason: 'element_missing' },
    },
    {
      label: 'invalid target failure',
      result: { success: false, status: 'failed', effect: 'none', errorCode: 'TARGET_DISABLED' },
      expected: { status: 'rejected_invalid', effect: 'none', code: 'TARGET_DISABLED' },
    },
    {
      label: 'cancel before mutation',
      result: {
        success: false,
        status: 'failed',
        effect: 'none',
        errorCode: 'EXECUTION_CANCELLED',
      },
      expected: { status: 'failed', effect: 'none', code: 'EXECUTION_CANCELLED' },
    },
    {
      label: 'cancel after mutation',
      result: {
        success: false,
        status: 'failed',
        effect: 'uncertain',
        errorCode: 'EXECUTION_CANCELLED',
      },
      expected: { status: 'uncertain', effect: 'uncertain', code: 'EXECUTION_CANCELLED' },
    },
    {
      label: 'timeout before mutation',
      result: { success: false, status: 'failed', effect: 'none', errorCode: 'EXECUTION_TIMEOUT' },
      expected: { status: 'failed', effect: 'none', code: 'EXECUTION_TIMEOUT' },
    },
    {
      label: 'timeout after mutation',
      result: {
        success: false,
        status: 'failed',
        effect: 'uncertain',
        errorCode: 'EXECUTION_TIMEOUT',
      },
      expected: { status: 'uncertain', effect: 'uncertain', code: 'EXECUTION_TIMEOUT' },
    },
    {
      label: 'other uncommitted failure',
      result: { success: false, status: 'failed', effect: 'none', errorCode: 'NETWORK_ERROR' },
      expected: { status: 'failed', effect: 'none', code: 'NETWORK_ERROR' },
    },
    {
      label: 'committed failure',
      result: { success: false, status: 'failed', effect: 'applied', errorCode: 'NETWORK_ERROR' },
      expected: { status: 'uncertain', effect: 'uncertain', code: 'NETWORK_ERROR' },
    },
    {
      label: 'failure with absent effect',
      result: { success: false, status: 'failed', effect: undefined },
      expected: { status: 'uncertain', effect: 'uncertain', code: 'EXECUTION_FAILED' },
    },
  ];
  test.each(mappingRows)('$label', async row => {
    mountHtml('<button>Act</button>');
    const target = host({ executor: { executeAction: async () => execution(row.result) } });
    const snapshot = await observe(target);
    expect(
      await target.execute(request(snapshot, { operation: 'CLICK', target: ref(snapshot, 'Act') }))
    ).toMatchObject(row.expected);
  });

  test('WAIT failures without an effect remain read-only', async () => {
    const target = host({
      executor: {
        executeAction: async () =>
          execution({
            success: false,
            status: 'failed',
            effect: undefined,
            errorCode: 'EXECUTION_FAILED',
          }),
      },
    });
    const snapshot = await observe(target);
    expect(
      await target.execute(request(snapshot, { operation: 'WAIT', durationMs: 250 }))
    ).toMatchObject({ status: 'failed', effect: 'none' });
  });

  test.each(['CLICK', 'WAIT'] as const)(
    'catches executor rejection for %s without retrying',
    async operation => {
      mountHtml('<button>Act</button>');
      const executeAction = jest
        .fn<
          ReturnType<TaskActionExecutor['executeAction']>,
          Parameters<TaskActionExecutor['executeAction']>
        >()
        .mockRejectedValue(new Error('Injected executor failure.'));
      const target = host({ executor: { executeAction } });
      const snapshot = await observe(target);
      const command: TaskHostCommand =
        operation === 'WAIT'
          ? { operation, durationMs: 250 }
          : { operation, target: ref(snapshot, 'Act') };
      expect(await target.execute(request(snapshot, command))).toMatchObject({
        status: operation === 'WAIT' ? 'failed' : 'uncertain',
        effect: operation === 'WAIT' ? 'none' : 'uncertain',
        code: 'EXECUTION_FAILED',
      });
      expect(executeAction).toHaveBeenCalledTimes(1);
    }
  );
});

describe('cancellation and privacy', () => {
  test('pre-aborted execute and observation return cancelled without invoking the engine', async () => {
    mountHtml('<button>Act</button>');
    const executor = engine();
    const spy = jest.spyOn(executor, 'executeAction');
    const target = host({ executor });
    const snapshot = await observe(target);
    const controller = new AbortController();
    controller.abort();
    expect(
      await target.execute(
        request(snapshot, { operation: 'CLICK', target: ref(snapshot, 'Act') }),
        controller.signal
      )
    ).toMatchObject({ status: 'failed', effect: 'none', code: 'EXECUTION_CANCELLED' });
    expect(await target.observe({ sessionId: 'ses_other' }, controller.signal)).toMatchObject({
      ok: false,
      error: { code: 'CANCELLED' },
    });
    expect(await target.capabilities(controller.signal)).toMatchObject({
      ok: false,
      error: { code: 'CANCELLED' },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  test('abort after a real click reports an uncertain effect', async () => {
    const root = mountHtml('<button>Act</button>');
    const controller = new AbortController();
    root.querySelector('button')?.addEventListener('click', () => controller.abort());
    const target = host();
    const snapshot = await observe(target);
    expect(
      await target.execute(
        request(snapshot, { operation: 'CLICK', target: ref(snapshot, 'Act') }),
        controller.signal
      )
    ).toMatchObject({ status: 'uncertain', effect: 'uncertain', code: 'EXECUTION_CANCELLED' });
  });

  test('sensitive fills are structurally promoted and engine events/readback expose no value or length', async () => {
    const root = mountHtml(
      '<input type="password" aria-label="Password"><div role="status"></div>'
    );
    const secret = randomBytes(24).toString('hex');
    const executor = engine();
    const eventTexts: string[] = [];
    for (const eventType of ['action_started', 'action_completed', 'action_failed'] as const) {
      executor.addEventListener(eventType, event => eventTexts.push(JSON.stringify(event)));
    }
    let sensitiveParameter = false;
    const target = host({
      executor: {
        executeAction: async (action, options) => {
          sensitiveParameter = action.sensitiveParameters?.includes('value') === true;
          return executor.executeAction(action, options);
        },
      },
    });
    const snapshot = await observe(target);
    const result = await target.execute(
      request(snapshot, {
        operation: 'FILL',
        target: ref(snapshot, 'Password'),
        value: secret,
        sensitive: false,
      })
    );
    expect(sensitiveParameter).toBe(true);
    expect(result).toMatchObject({
      status: 'applied',
      effect: 'applied',
      readback: { kind: 'fill', empty: false, matched: true },
    });
    expect(result.readback && 'length' in result.readback).toBe(false);
    expect(eventTexts.some(text => text.includes(secret))).toBe(false);
    expect(JSON.stringify(result).includes(secret)).toBe(false);
    (root.querySelector('[role=status]') as HTMLElement).textContent = secret;
    const next = await observe(target);
    expect(JSON.stringify(next).includes(secret)).toBe(false);
    expect(element(next, 'Password').state.value).toBe(TASK_REDACTED);
  });

  test('executor echo messages and arbitrary data are scrubbed or omitted', async () => {
    mountHtml('<input type="password" aria-label="Password">');
    const secret = randomBytes(24).toString('hex');
    const target = host({
      executor: {
        executeAction: async () =>
          execution({
            success: false,
            status: 'failed',
            effect: 'uncertain',
            error: `Injected ${secret}`,
            data: {
              kind: 'fill',
              tag: 'input',
              inputType: 'password',
              changed: true,
              matched: false,
              length: secret.length,
              value: secret,
              text: secret,
              empty: false,
            },
          }),
      },
    });
    const snapshot = await observe(target);
    const result = await target.execute(
      request(snapshot, {
        operation: 'FILL',
        target: ref(snapshot, 'Password'),
        value: secret,
        sensitive: true,
      })
    );
    expect(JSON.stringify(result).includes(secret)).toBe(false);
    expect(result.message?.includes(TASK_REDACTED)).toBe(true);
    expect(result.readback && 'length' in result.readback).toBe(false);
    expect(result.readback && 'value' in result.readback).toBe(false);
    expect(result.readback && 'text' in result.readback).toBe(false);
  });

  test('a throwing executor cannot echo a sensitive fill value', async () => {
    mountHtml('<input type="password" aria-label="Password">');
    const secret = randomBytes(24).toString('hex');
    const target = host({
      executor: {
        executeAction: async () => {
          throw new Error(`Injected ${secret}`);
        },
      },
    });
    const snapshot = await observe(target);
    const result = await target.execute(
      request(snapshot, {
        operation: 'FILL',
        target: ref(snapshot, 'Password'),
        value: secret,
        sensitive: true,
      })
    );
    expect(result).toMatchObject({
      status: 'uncertain',
      effect: 'uncertain',
      code: 'EXECUTION_FAILED',
    });
    expect(JSON.stringify(result).includes(secret)).toBe(false);
  });

  test('sensitive option values and masked labels still have exact private freshness checks', async () => {
    const root = mountHtml(
      '<select data-kriya-sensitive aria-label="Private choice"><option value="first">first</option><option value="second">second</option></select>'
    );
    const executor = engine();
    const spy = jest.spyOn(executor, 'executeAction');
    const target = host({ executor });
    const snapshot = await observe(target);
    const optionId = element(snapshot, 'Private choice').options?.[1]?.id;
    expect(element(snapshot, 'Private choice').options?.[1]).toMatchObject({
      label: TASK_REDACTED,
    });
    (root.querySelectorAll('option')[1] as HTMLOptionElement).value = 'changed';
    expect(
      await target.execute(
        request(snapshot, {
          operation: 'SELECT',
          target: ref(snapshot, 'Private choice'),
          optionId,
        })
      )
    ).toMatchObject({ status: 'rejected_stale', effect: 'none', staleReason: 'option_changed' });
    expect(spy).not.toHaveBeenCalled();
  });
});
