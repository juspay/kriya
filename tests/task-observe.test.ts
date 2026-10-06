import { randomBytes } from 'crypto';
import { createTaskObserver, isSensitiveElement } from '@/agent/browser/observe';
import { TASK_LIMITS, TASK_REDACTED } from '@/types';
import type { TaskElement, TaskObservation, TaskObserver, TaskTargetRef } from '@/types';
import { counterIds, makeCapabilities } from './helpers/agent-fixtures';
import { commandDigest, compileCommand, computeOffers } from '@/agent/commands';
import { derivePostconditions } from '@/agent/verify';
import { createTaskPolicy, normalizeAuthorization } from '@/agent/policy';
import {
  installLayoutStubs,
  layoutColumn,
  makeScrollable,
  mountHtml,
  resetDom,
  setBox,
  setViewport,
} from './helpers/domHarness';

const observers: TaskObserver<HTMLElement>[] = [];
function observer(
  config: Parameters<typeof createTaskObserver>[0] = {}
): TaskObserver<HTMLElement> {
  const result = createTaskObserver({
    createId: counterIds(),
    settle: { quietMs: 0, maxMs: 10 },
    ...config,
  });
  observers.push(result);
  return result;
}
function ref(
  snapshot: TaskObservation,
  entry: TaskElement = snapshot.elements[0] as TaskElement
): TaskTargetRef {
  return {
    sessionId: snapshot.sessionId,
    snapshotId: snapshot.snapshotId,
    targetId: entry.id,
    signature: entry.signature,
  };
}
function byLabel(snapshot: TaskObservation, label: string): TaskElement {
  const result = snapshot.elements.find(entry => entry.label === label);
  expect(result).toBeDefined();
  return result as TaskElement;
}

test('observes native validation opt-outs and invalidates references when they change', async () => {
  const root = mountHtml(
    '<form novalidate><input aria-label="Region" required><button type="submit">Review</button></form>'
  );
  const host = observer();
  const before = await host.observe({ sessionId: 'ses_a' });
  expect(byLabel(before, 'Region').formNoValidate).toBe(true);
  expect(byLabel(before, 'Review').formNoValidate).toBe(true);
  const form = root.querySelector('form') as HTMLFormElement;
  form.noValidate = false;
  const after = await host.observe({ sessionId: 'ses_a' });
  expect(byLabel(after, 'Review').signature).not.toBe(byLabel(before, 'Review').signature);
  const button = root.querySelector('button') as HTMLButtonElement;
  button.formNoValidate = true;
  const override = await host.observe({ sessionId: 'ses_a' });
  expect(byLabel(override, 'Review').formNoValidate).toBe(true);
  expect(byLabel(override, 'Region').formNoValidate).toBe(true);
});

test('implicit Enter observes the default submitter overrides and stale destinations', async () => {
  const root = mountHtml(
    '<form id="delivery" action="/pay" method="post"><input aria-label="Region" required aria-invalid="true"><button type="submit" formnovalidate formaction="/review" formmethod="get">Review</button><button type="submit" formaction="/pay">Pay</button></form>'
  );
  const host = observer();
  const before = await host.observe({ sessionId: 'ses_a' });
  const input = byLabel(before, 'Region');
  expect(input.formNoValidate).toBe(true);
  expect(input.formTarget).toEqual({
    action: new URL('/review', document.baseURI).href,
    method: 'GET',
  });
  expect(input.state.invalid).toBe(true);
  const defaultButton = root.querySelector('button') as HTMLButtonElement;
  defaultButton.setAttribute('formaction', '/pay');
  expect(host.resolve(ref(before, input))).toEqual({ ok: false, reason: 'structure_changed' });
  const after = await host.observe({ sessionId: 'ses_a' });
  expect(byLabel(after, 'Region').formTarget?.action).toBe(new URL('/pay', document.baseURI).href);
  expect(byLabel(after, 'Region').signature).not.toBe(input.signature);
});

test('novalidate retains explicit server validation while suppressing native constraints', async () => {
  mountHtml(
    '<form novalidate><input aria-label="Region" required aria-invalid="true"><button>Review</button></form>'
  );
  const snapshot = await observer().observe({ sessionId: 'ses_a' });
  expect(byLabel(snapshot, 'Region').state).toMatchObject({
    required: true,
    invalid: true,
    constraintInvalid: false,
  });
  expect(snapshot.validation).toEqual([]);
});

test('only active server descriptions are associated with validation after native opt-out', async () => {
  const root = mountHtml(
    '<form novalidate><input type="email" required aria-label="Email" aria-describedby="hint error"><span id="hint">Receipt contact</span><span id="error">Enter your email address.</span><button>Continue</button></form>'
  );
  const host = observer();
  const before = await host.observe({ sessionId: 'ses_a' });
  expect(before.validation).toEqual([]);
  const field = root.querySelector('input') as HTMLInputElement;
  field.setAttribute('aria-invalid', 'true');
  field.setAttribute('aria-errormessage', 'error');
  const after = await host.observe({ sessionId: 'ses_a' });
  const email = byLabel(after, 'Email');
  expect(email.state).toMatchObject({ required: true, invalid: true, constraintInvalid: false });
  expect(after.validation).toEqual([
    { source: 'aria', text: 'Enter your email address.', targetId: email.id },
    { source: 'aria', text: 'Receipt contact', targetId: email.id },
  ]);
});

test('server validation follows visible bound labels and respects sensitivity and visibility', async () => {
  const root = mountHtml(
    '<input type="checkbox" id="choice" aria-invalid="true" aria-describedby="choice-error hidden-error"><label for="choice">Agree</label><span id="choice-error">Choose this option.</span><span id="hidden-error" hidden>Hidden error</span><input type="password" aria-label="Password" aria-invalid="true" aria-describedby="private-error"><span id="private-error">private-validation-value</span>'
  );
  setBox(root.querySelector('input') as HTMLElement, { top: 0, width: 0, height: 0 });
  const snapshot = await observer().observe({ sessionId: 'ses_a' });
  expect(snapshot.validation).toEqual([
    { source: 'aria', text: 'Choose this option.', targetId: byLabel(snapshot, 'Agree').id },
  ]);
});

beforeEach(() => {
  resetDom();
  installLayoutStubs();
  setViewport({ width: 1000, height: 900, scrollHeight: 1800 });
});
afterEach(() => {
  observers.splice(0).forEach(item => item.dispose());
  resetDom();
});

describe('task observer semantics', () => {
  test('offers operations from native controls and structural submission hints', async () => {
    mountHtml(
      '<form action="/save" method="post"><label for="name">Name</label><input id="name"><button>Save</button><button type="button">Preview</button><input type="checkbox" aria-label="Agree"><textarea aria-label="Message"></textarea><select aria-label="Size"><option value="s">Small</option><option value="l">Large</option></select></form><a href="/next">Next</a><p>Readable text</p><summary>Details</summary>'
    );
    const result = await observer().observe({ sessionId: 'ses_a' });
    expect(byLabel(result, 'Name').operations).toEqual(['FILL', 'PRESS']);
    expect(byLabel(result, 'Name').commitHints).toContainEqual({
      class: 'FORM_SUBMIT',
      basis: 'implicit_submit_field',
    });
    expect(byLabel(result, 'Save').operations).toEqual(['SUBMIT', 'READ']);
    expect(byLabel(result, 'Save').formTarget).toEqual({
      action: 'http://localhost/save',
      method: 'POST',
    });
    expect(byLabel(result, 'Preview').operations).toEqual(['CLICK', 'READ']);
    expect(byLabel(result, 'Agree').operations).toEqual(['SET_CHECKED']);
    expect(byLabel(result, 'Message').operations).toEqual(['FILL', 'PRESS']);
    expect(byLabel(result, 'Size').operations).toEqual(['SELECT']);
    expect(byLabel(result, 'Next').operations).toEqual(['NAVIGATE', 'READ']);
    expect(byLabel(result, 'Readable text').operations).toEqual(['READ']);
    expect(byLabel(result, 'Details').operations).toEqual(['CLICK', 'READ']);
    const options = byLabel(result, 'Size').options;
    expect(options?.map(item => item.id)).toEqual([
      `${byLabel(result, 'Size').id}.1`,
      `${byLabel(result, 'Size').id}.2`,
    ]);
    expect(result.forms[0]?.fieldIds).toHaveLength(4);
    expect(result.forms[0]?.submitterIds).toEqual([byLabel(result, 'Save').id]);
  });

  test('offers ARIA control operations and native read-only restrictions', async () => {
    mountHtml(
      '<div role="tab">Tab</div><div role="menuitem">Item</div><div role="combobox">Choose</div><div role="switch" aria-checked="mixed" aria-label="Light"></div><div role="listbox"><div role="option" aria-selected="true">Choice</div></div><input readonly aria-label="Locked"><input disabled aria-label="Disabled"><button disabled>Unavailable</button><div role="radio" aria-checked="false" name="group" aria-label="One"></div>'
    );
    const result = await observer().observe({ sessionId: 'ses_a' });
    for (const label of ['Tab', 'Item', 'Choose']) {
      expect(byLabel(result, label).operations).toContain('CLICK');
    }
    expect(byLabel(result, 'Light').state.checked).toBe('mixed');
    expect(byLabel(result, 'Light').operations).toEqual(['SET_CHECKED']);
    expect(byLabel(result, 'Choice').operations).toContain('SELECT');
    expect(byLabel(result, 'Choice').state.selected).toBe(true);
    expect(byLabel(result, 'Locked').operations).toEqual([]);
    expect(byLabel(result, 'Disabled').operations).toEqual([]);
    expect(byLabel(result, 'Unavailable').operations).toEqual(['READ']);
    expect(byLabel(result, 'One').groupId).toBeUndefined();
  });

  test.each(['switch', 'checkbox', 'radio'] as const)(
    'native button role %s exposes checked semantics rather than CLICK',
    async role => {
      const root = mountHtml(
        `<div role="radiogroup" id="choices"><button type="button" role="${role}" aria-label="Choice" aria-checked="false"></button></div>`
      );
      const host = observer();
      const before = await host.observe({ sessionId: 'ses_a' });
      const entry = byLabel(before, 'Choice');
      expect(entry).toMatchObject({
        role,
        kind: role,
        state: { checked: false },
        operations: ['SET_CHECKED'],
      });
      expect(entry.operations).not.toContain('CLICK');
      if (role === 'radio') {
        expect(entry.groupId).toMatch(/^aria:g\d+$/);
      }
      (root.querySelector('button') as HTMLElement).setAttribute('aria-checked', 'true');
      expect(host.resolve(ref(before, entry)).ok).toBe(true);
      const after = await host.observe({ sessionId: 'ses_a' });
      expect(byLabel(after, 'Choice').state.checked).toBe(true);
      expect(byLabel(after, 'Choice').signature).toBe(entry.signature);
    }
  );

  test('native switch metadata compiles SET_CHECKED and supplies a checked postcondition', async () => {
    mountHtml(
      '<button type="button" role="switch" aria-checked="true" aria-label="Light"></button>'
    );
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    const entry = byLabel(snapshot, 'Light');
    const capabilities = makeCapabilities();
    const offers = computeOffers({
      observation: snapshot,
      capabilities,
      allowedOperations: capabilities.operations,
      allowRunLoss: false,
      exclude: [],
    });
    const compiled = compileCommand({
      goal: 'Turn off the light.',
      observation: snapshot,
      offers,
      capabilities,
      operation: 'SET_CHECKED',
      targetId: entry.id,
      argument: { source: 'protocol', slot: 'checked', token: 'UNCHECKED' },
      inputRules: [],
      resolvers: [],
      origins: [snapshot.origin],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      throw new Error('Expected an idempotent checked-state command.');
    }
    expect(compiled.command).toMatchObject({ operation: 'SET_CHECKED', checked: false });
    expect(derivePostconditions({ command: compiled.command, target: entry })).toEqual([
      expect.objectContaining({
        kind: 'checked',
        signature: entry.signature,
        label: 'Light',
        checked: false,
      }),
    ]);
  });

  test('native checkbox button preserves mixed ARIA state', async () => {
    mountHtml(
      '<button type="button" role="checkbox" aria-checked="mixed" aria-label="Choice"></button>'
    );
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    expect(byLabel(snapshot, 'Choice')).toMatchObject({
      kind: 'checkbox',
      state: { checked: 'mixed' },
      operations: ['SET_CHECKED'],
    });
  });

  test('native button option in a listbox offers SELECT instead of CLICK', async () => {
    mountHtml(
      '<div role="listbox"><button role="option" aria-selected="false" aria-label="Choice">Visible option</button></div>'
    );
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    const entry = byLabel(snapshot, 'Choice');
    expect(entry).toMatchObject({ kind: 'option', role: 'option', state: { selected: false } });
    expect(entry.operations).toContain('SELECT');
    expect(entry.operations).not.toContain('CLICK');
  });

  test('native tab menuitem and combobox buttons preserve CLICK activation', async () => {
    mountHtml(
      '<button role="tab" aria-selected="false">Tab</button><button role="menuitem">Item</button><button role="combobox" aria-expanded="false">Choose</button><button>Ordinary</button>'
    );
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    for (const [label, kind] of [
      ['Tab', 'tab'],
      ['Item', 'menuitem'],
      ['Choose', 'combobox'],
      ['Ordinary', 'button'],
    ] as const) {
      const entry = byLabel(snapshot, label);
      expect(entry.kind).toBe(kind);
      expect(entry.operations).toContain('CLICK');
      expect(entry.operations).not.toContain('SET_CHECKED');
    }
    expect(byLabel(snapshot, 'Tab').state.selected).toBe(false);
  });

  test('native form submission semantics remain stronger than button ARIA roles', async () => {
    mountHtml(
      '<form action="/save"><button role="switch" aria-checked="false" aria-label="Submit switch">Save</button><button type="submit" role="option" aria-selected="false" aria-label="Submit option">Commit</button><input type="submit" role="radio" aria-checked="false" aria-label="Submit input" value="Send"></form>'
    );
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    for (const label of ['Submit switch', 'Submit option', 'Submit input']) {
      const entry = byLabel(snapshot, label);
      expect(entry.operations).toContain('SUBMIT');
      expect(entry.operations).not.toContain('CLICK');
      expect(entry.operations).not.toContain('SET_CHECKED');
      expect(entry.operations).not.toContain('SELECT');
      expect(entry.commitHints).toContainEqual({ class: 'FORM_SUBMIT', basis: 'submit_control' });
    }
  });

  test('native inputs textareas and selects retain their physical control semantics', async () => {
    mountHtml(
      '<input type="checkbox" role="button" checked aria-checked="false" aria-label="Native check"><input type="radio" role="button" checked aria-checked="false" aria-label="Native radio"><input type="text" role="button" aria-label="Native text"><textarea role="button" aria-label="Native area"></textarea><select role="button" aria-label="Native select"><option>One</option></select>'
    );
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    expect(byLabel(snapshot, 'Native check')).toMatchObject({
      kind: 'checkbox',
      state: { checked: true },
      operations: ['SET_CHECKED'],
    });
    expect(byLabel(snapshot, 'Native radio')).toMatchObject({
      kind: 'radio',
      state: { checked: true },
      operations: ['SET_CHECKED'],
    });
    expect(byLabel(snapshot, 'Native text')).toMatchObject({
      kind: 'text_input',
      operations: ['FILL', 'PRESS'],
    });
    expect(byLabel(snapshot, 'Native area')).toMatchObject({
      kind: 'textarea',
      operations: ['FILL', 'PRESS'],
    });
    expect(byLabel(snapshot, 'Native select')).toMatchObject({
      kind: 'select',
      operations: ['SELECT'],
    });
  });

  test('native checkable-role buttons without checked state do not offer blind toggle actions', async () => {
    mountHtml('<button role="switch">Unknown state</button>');
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    expect(byLabel(snapshot, 'Unknown state')).toMatchObject({
      kind: 'switch',
      operations: ['READ'],
    });
    expect(byLabel(snapshot, 'Unknown state').state.checked).toBeUndefined();
  });

  test('disabled native ARIA switch buttons remain read-only', async () => {
    mountHtml('<button disabled role="switch" aria-checked="true">Protected</button>');
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    expect(byLabel(snapshot, 'Protected')).toMatchObject({
      kind: 'switch',
      state: { checked: true, disabled: true },
      operations: ['READ'],
    });
  });

  test('native option-role buttons outside a listbox offer reading only', async () => {
    mountHtml('<button role="option" aria-selected="false">Outside option</button>');
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    expect(byLabel(snapshot, 'Outside option')).toMatchObject({
      kind: 'option',
      operations: ['READ'],
    });
  });

  test('visible labels expose the bound checkbox state even when the native control has no box', async () => {
    const root = mountHtml('<input type="checkbox" id="agree"><label for="agree">Agree</label>');
    const input = root.querySelector('input') as HTMLInputElement;
    input.checked = true;
    setBox(input, { top: 10, width: 0, height: 0 });
    setBox(root.querySelector('label') as HTMLElement, { top: 50 });
    const host = observer();
    const snapshot = await host.observe({ sessionId: 'ses_a' });
    expect(snapshot.elements).toHaveLength(1);
    expect(snapshot.elements[0]).toMatchObject({
      kind: 'checkbox',
      label: 'Agree',
      state: { checked: true },
      operations: ['SET_CHECKED', 'READ'],
    });
    expect(host.resolve(ref(snapshot)).ok).toBe(true);
    input.disabled = true;
    expect(host.resolve(ref(snapshot))).toEqual({ ok: false, reason: 'structure_changed' });
  });

  test('hidden control purchase markers survive visible-label targeting and require approval', async () => {
    const root = mountHtml(
      '<input type="checkbox" id="paid" data-kriya-commit="purchase"><label for="paid">Paid option</label>'
    );
    setBox(root.querySelector('input') as HTMLElement, { top: 10, width: 0, height: 0 });
    setBox(root.querySelector('label') as HTMLElement, { top: 50 });
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    const entry = byLabel(snapshot, 'Paid option');
    expect(snapshot.elements).toHaveLength(1);
    expect(entry.commitHints).toEqual([{ class: 'PURCHASE', basis: 'declared_marker' }]);
    const capabilities = makeCapabilities();
    const offers = computeOffers({
      observation: snapshot,
      capabilities,
      allowedOperations: capabilities.operations,
      allowRunLoss: false,
      exclude: [],
    });
    const compiled = compileCommand({
      goal: 'Enable the paid option.',
      observation: snapshot,
      offers,
      capabilities,
      operation: 'SET_CHECKED',
      targetId: entry.id,
      argument: { source: 'protocol', slot: 'checked', token: 'CHECKED' },
      inputRules: [],
      resolvers: [],
      origins: [snapshot.origin],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      throw new Error('Expected a checked-state command.');
    }
    const policy = createTaskPolicy();
    const classified = policy.classify({
      command: compiled.command,
      element: entry,
      observation: snapshot,
    });
    expect(classified.effects).toContain('purchase');
    const digest = commandDigest({
      command: compiled.command,
      effects: classified.effects,
      origin: snapshot.origin,
      target: entry,
    });
    const authorization = normalizeAuthorization(
      { origins: [snapshot.origin] },
      snapshot.origin,
      capabilities
    );
    expect(
      policy.evaluate({
        command: compiled.command,
        effects: classified.effects,
        digest,
        snapshotId: snapshot.snapshotId,
        documentId: snapshot.documentId,
        element: entry,
        pageUrl: snapshot.url,
        now: 1,
        contextDigest: `cx_${'0'.repeat(32)}`,
        authorization,
        pendingCommitments: [],
      })
    ).toMatchObject({ verdict: 'require_approval' });
  });

  test('visible label and native control markers are unioned in canonical order without duplicates', async () => {
    const root = mountHtml(
      '<input type="checkbox" id="paid" data-kriya-commit="send"><label for="paid" data-kriya-commit="purchase">Paid option</label>'
    );
    setBox(root.querySelector('input') as HTMLElement, { top: 10, width: 0, height: 0 });
    setBox(root.querySelector('label') as HTMLElement, { top: 50 });
    const host = observer();
    const first = await host.observe({ sessionId: 'ses_a' });
    expect(byLabel(first, 'Paid option').commitHints).toEqual([
      { class: 'PURCHASE', basis: 'declared_marker' },
      { class: 'SEND', basis: 'declared_marker' },
    ]);
    (root.querySelector('input') as HTMLElement).setAttribute('data-kriya-commit', 'purchase');
    const second = await host.observe({ sessionId: 'ses_a' });
    expect(byLabel(second, 'Paid option').commitHints).toEqual([
      { class: 'PURCHASE', basis: 'declared_marker' },
    ]);
    (root.querySelector('label') as HTMLElement).removeAttribute('data-kriya-commit');
    const third = await host.observe({ sessionId: 'ses_a' });
    expect(byLabel(third, 'Paid option').commitHints).toEqual([
      { class: 'PURCHASE', basis: 'declared_marker' },
    ]);
    expect(byLabel(third, 'Paid option').signature).toBe(byLabel(second, 'Paid option').signature);
  });

  test.each(['checkbox', 'radio'] as const)(
    'changing an effective %s control marker invalidates its held label target',
    async type => {
      const root = mountHtml(
        `<input type="${type}" id="choice" name="plan"><label for="choice">Choice</label>`
      );
      setBox(root.querySelector('input') as HTMLElement, { top: 10, width: 0, height: 0 });
      setBox(root.querySelector('label') as HTMLElement, { top: 50 });
      const host = observer();
      const before = await host.observe({ sessionId: 'ses_a' });
      (root.querySelector('input') as HTMLElement).setAttribute('data-kriya-commit', 'purchase');
      expect(host.resolve(ref(before, byLabel(before, 'Choice')))).toEqual({
        ok: false,
        reason: 'structure_changed',
      });
      const after = await host.observe({ sessionId: 'ses_a' });
      expect(byLabel(after, 'Choice').commitHints).toEqual([
        { class: 'PURCHASE', basis: 'declared_marker' },
      ]);
      expect(byLabel(after, 'Choice').signature).not.toBe(byLabel(before, 'Choice').signature);
    }
  );

  test('stable form ids and radio group ids survive observations', async () => {
    mountHtml(
      '<form><input type="radio" name="plan" aria-label="Basic"><input type="radio" name="plan" aria-label="Pro"></form>'
    );
    const host = observer();
    const first = await host.observe({ sessionId: 'ses_a' });
    const second = await host.observe({ sessionId: 'ses_a' });
    expect(second.forms[0]?.id).toBe(first.forms[0]?.id);
    expect(second.elements[0]?.groupId).toBe(`${first.forms[0]?.id}:plan`);
    expect(second.elements[1]?.groupId).toBe(second.elements[0]?.groupId);
  });

  test('only actual exclusive native names share a group, with form ownership preserved', async () => {
    mountHtml(
      '<input type="radio" aria-label="Independent A"><input type="radio" name="" aria-label="Independent B"><input type="radio" name="choice" aria-label="Document A"><input type="radio" name="choice" aria-label="Document B"><form id="first"><input type="radio" name="choice" aria-label="Form A"></form><form id="second"><input type="radio" name="choice" aria-label="Form B"></form><input type="radio" form="first" name="choice" aria-label="External A">'
    );
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    expect(byLabel(snapshot, 'Independent A').groupId).toBeUndefined();
    expect(byLabel(snapshot, 'Independent B').groupId).toBeUndefined();
    expect(byLabel(snapshot, 'Document A').groupId).toBe(byLabel(snapshot, 'Document B').groupId);
    expect(byLabel(snapshot, 'External A').groupId).toBe(byLabel(snapshot, 'Form A').groupId);
    expect(byLabel(snapshot, 'Form A').groupId).not.toBe(byLabel(snapshot, 'Form B').groupId);
    expect(byLabel(snapshot, 'Form A').groupId).not.toBe(byLabel(snapshot, 'Document A').groupId);
  });

  test('ARIA radiogroups use actual container identity even with missing or duplicate DOM ids', async () => {
    const root = mountHtml(
      '<div role="radiogroup" id="duplicate"><button type="button" role="radio" aria-checked="false">First A</button><button type="button" role="radio" aria-checked="false">First B</button></div><div role="radiogroup" id="duplicate"><button type="button" role="radio" aria-checked="false">Second A</button></div><div role="radiogroup"><button type="button" role="radio" aria-checked="false">Third A</button><input type="radio" aria-label="Native independent"></div>'
    );
    const host = observer();
    const first = await host.observe({ sessionId: 'ses_a' });
    expect(byLabel(first, 'First A').groupId).toBe(byLabel(first, 'First B').groupId);
    const groupIds = ['First A', 'Second A', 'Third A'].map(label => byLabel(first, label).groupId);
    expect(new Set(groupIds).size).toBe(3);
    expect(groupIds.every(id => id?.startsWith('aria:'))).toBe(true);
    expect(byLabel(first, 'Native independent').groupId).toBeUndefined();
    const second = await host.observe({ sessionId: 'ses_a' });
    expect(byLabel(second, 'First A').groupId).toBe(byLabel(first, 'First A').groupId);
    const groups = root.querySelectorAll('[role=radiogroup]');
    groups[1]?.appendChild(groups[0]?.querySelector('button') as HTMLButtonElement);
    expect(host.resolve(ref(second, byLabel(second, 'First A')))).toEqual({
      ok: false,
      reason: 'structure_changed',
    });
  });

  test('native and label twins share opaque control identity, duplicate values do not', async () => {
    const root = mountHtml(
      '<form><input type="radio" name="choice" id="first" value="on"><label for="first">Same choice</label><input type="radio" name="choice" id="second" value="on"><label for="second">Same choice</label></form>'
    );
    const host = observer();
    const snapshot = await host.observe({ sessionId: 'ses_a' });
    const members = snapshot.elements.filter(element => element.kind === 'radio');
    expect(members).toHaveLength(4);
    expect(members[0]?.controlId).toBe(members[1]?.controlId);
    expect(members[2]?.controlId).toBe(members[3]?.controlId);
    expect(members[0]?.controlId).not.toBe(members[2]?.controlId);
    expect(new Set(members.map(member => member.state.value))).toEqual(new Set(['on']));
    expect(new Set(members.map(member => member.groupId)).size).toBe(1);
    expect(members.every(member => /^ctl_\d+$/.test(member.controlId ?? ''))).toBe(true);
    const heldLabel = members[1] as TaskElement;
    const native = root.querySelector('input') as HTMLInputElement;
    native.replaceWith(native.cloneNode(true));
    expect(host.resolve(ref(snapshot, heldLabel))).toEqual({
      ok: false,
      reason: 'structure_changed',
    });
  });

  test('native choice machine-value changes invalidate held targets without exposing sensitive values', async () => {
    const firstValue = randomBytes(24).toString('hex');
    const secondValue = randomBytes(24).toString('hex');
    const root = mountHtml(
      `<input type="radio" name="choice" value="${firstValue}" data-kriya-sensitive aria-label="Private choice">`
    );
    const host = observer();
    const first = await host.observe({ sessionId: 'ses_a' });
    (root.querySelector('input') as HTMLInputElement).value = secondValue;
    expect(host.resolve(ref(first))).toEqual({ ok: false, reason: 'signature_changed' });
    const second = await host.observe({ sessionId: 'ses_a' });
    expect(second.elements[0]?.signature).not.toBe(first.elements[0]?.signature);
    expect(JSON.stringify(first)).not.toContain(firstValue);
    expect(JSON.stringify(second)).not.toContain(secondValue);
  });

  test('native fieldset legends preserve actual form scope for optional supplied details', async () => {
    mountHtml(
      '<main><h1>Shipping details</h1><form><fieldset><legend>Contact information</legend><input type="tel" autocomplete="tel" aria-label="Phone (optional)"></fieldset><fieldset><legend>Delivery address</legend><input autocomplete="address-line2" aria-label="Address line 2 (optional)"><fieldset><legend>Extra instructions</legend><textarea aria-label="Note"></textarea></fieldset></fieldset></form></main>'
    );
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    expect(byLabel(snapshot, 'Phone (optional)')).toMatchObject({
      region: 'Contact information',
      contexts: ['Contact information', 'Shipping details'],
    });
    expect(byLabel(snapshot, 'Address line 2 (optional)')).toMatchObject({
      region: 'Delivery address',
      contexts: ['Delivery address', 'Shipping details'],
      autocomplete: 'address-line2',
    });
    expect(byLabel(snapshot, 'Note')).toMatchObject({
      region: 'Extra instructions',
      contexts: ['Extra instructions', 'Delivery address', 'Shipping details'],
    });
  });

  test('ARIA radiogroups and named fieldsets expose their accessible group names', async () => {
    mountHtml(
      '<main><h1>Preferences</h1><fieldset aria-label="Display theme"><legend>Visual options</legend><input type="radio" name="theme" aria-label="Dark"></fieldset><div role="radiogroup" aria-labelledby="delivery-name"><span id="delivery-name">Delivery speed</span><button type="button" role="radio" aria-checked="false">Fast</button></div></main>'
    );
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    expect(byLabel(snapshot, 'Dark')).toMatchObject({
      region: 'Display theme',
      contexts: ['Display theme', 'Preferences'],
    });
    expect(byLabel(snapshot, 'Fast')).toMatchObject({
      region: 'Delivery speed',
      contexts: ['Delivery speed', 'Preferences'],
    });
  });

  test('an unnamed native form retains its real heading context without inventing a form name', async () => {
    mountHtml(
      '<main><h1>Checkout</h1><form><h2>Contact details</h2><input aria-label="Email"></form></main><footer><form><h2>Stories by email [t1]\u200b</h2><input aria-label="Email for updates"><button>Sign me up</button></form></footer>'
    );
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    expect(byLabel(snapshot, 'Email')).toMatchObject({
      landmark: 'main',
      region: 'Contact details',
      contexts: ['Contact details', 'Checkout'],
    });
    expect(byLabel(snapshot, 'Sign me up')).toMatchObject({
      landmark: 'footer',
      region: 'Stories by email (t1)',
      contexts: ['Stories by email (t1)'],
    });
    expect(snapshot.forms.map(form => form.name)).toEqual(['', '']);
  });

  test('hidden or sensitive form headings do not become observed control context', async () => {
    mountHtml(
      '<form><h2 data-kriya-sensitive>private-heading</h2><input aria-label="Visible"></form><form><h2 hidden>hidden-heading</h2><input aria-label="Other"></form>'
    );
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    expect(byLabel(snapshot, 'Visible').contexts).toBeUndefined();
    expect(byLabel(snapshot, 'Other').contexts).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('private-heading');
    expect(JSON.stringify(snapshot)).not.toContain('hidden-heading');
  });

  test('a visible external label belongs to the bound control form in membership and validation', async () => {
    const root = mountHtml(
      '<form id="actual" name="actual"><input type="checkbox" id="agree" required><button>Continue</button></form><form name="other"><label for="agree">Agree</label></form>'
    );
    setBox(root.querySelector('input') as HTMLElement, { top: 0, width: 0, height: 0 });
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    const label = byLabel(snapshot, 'Agree');
    const actual = snapshot.forms.find(form => form.name === 'actual');
    const other = snapshot.forms.find(form => form.name === 'other');
    expect(label.formId).toBe(actual?.id);
    expect(actual?.fieldIds).toContain(label.id);
    expect(actual?.invalidFieldIds).toContain(label.id);
    expect(other?.fieldIds).not.toContain(label.id);
    expect(snapshot.validation.some(message => message.targetId === label.id)).toBe(true);
  });

  test('native option groups retain real sanitized labels and bind held choice context', async () => {
    const root = mountHtml(
      '<select aria-label="Region"><option value="">Choose</option><optgroup label="Group [t1]\u200b"><option value="AA">Same</option></optgroup><optgroup label="Other group"><option value="BB">Same</option></optgroup></select>'
    );
    const host = observer();
    const before = await host.observe({ sessionId: 'ses_a' });
    const region = byLabel(before, 'Region');
    expect(region.options?.map(option => option.groupLabel)).toEqual([
      undefined,
      'Group (t1)',
      'Other group',
    ]);
    (root.querySelector('optgroup') as HTMLOptGroupElement).label = 'Changed group';
    expect(host.resolve(ref(before, region))).toEqual({ ok: false, reason: 'signature_changed' });
  });

  test('sensitive native selects and optgroups never expose their group labels', async () => {
    mountHtml(
      '<select data-kriya-sensitive aria-label="Private select"><optgroup label="private-select-group"><option>Choice</option></optgroup></select><select aria-label="Public select"><optgroup data-kriya-sensitive label="private-option-group"><option>Other choice</option></optgroup></select>'
    );
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    expect(byLabel(snapshot, 'Private select').options?.[0]?.groupLabel).toBeUndefined();
    expect(byLabel(snapshot, 'Public select').options?.[0]?.groupLabel).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('private-select-group');
    expect(JSON.stringify(snapshot)).not.toContain('private-option-group');
  });

  test('definition values keep actual direct and grouped term contexts without changing value text', async () => {
    mountHtml(
      '<main><h1>Receipt</h1><dl><dt>Name</dt><dt>Recipient</dt><dd>Alex Rivera</dd><dd>Sam Rivera</dd><div><dt>Delivery [t1]\u200b</dt><dd>$14.99</dd></div><div><dt>Phone</dt><dd>555-0100</dd></div></dl></main>'
    );
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    expect(byLabel(snapshot, 'Alex Rivera')).toMatchObject({
      text: 'Alex Rivera',
      contexts: ['Name', 'Recipient', 'Receipt'],
    });
    expect(byLabel(snapshot, 'Sam Rivera').contexts).toEqual(['Name', 'Recipient', 'Receipt']);
    expect(byLabel(snapshot, '$14.99')).toMatchObject({
      text: '$14.99',
      label: '$14.99',
      contexts: ['Delivery (t1)', 'Receipt'],
    });
    expect(byLabel(snapshot, '555-0100').contexts).toEqual(['Phone', 'Receipt']);
  });

  test('definition context excludes hidden/sensitive terms and does not cross unrelated groups', async () => {
    mountHtml(
      '<dl><dt hidden>hidden-term</dt><dd>Visible A</dd><dt data-kriya-sensitive>private-term</dt><dd>Visible B</dd><div><dt>Other group</dt><dd>Other value</dd></div><div><dd>Unlabelled group</dd></div></dl><dd>Outside list</dd>'
    );
    const snapshot = await observer().observe({ sessionId: 'ses_a' });
    expect(byLabel(snapshot, 'Visible A').contexts).toBeUndefined();
    expect(byLabel(snapshot, 'Visible B').contexts).toBeUndefined();
    expect(byLabel(snapshot, 'Unlabelled group').contexts).toBeUndefined();
    expect(byLabel(snapshot, 'Outside list').contexts).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('hidden-term');
    expect(JSON.stringify(snapshot)).not.toContain('private-term');
  });

  test('a changed definition term invalidates its held value reference', async () => {
    const root = mountHtml('<dl><dt>Delivery</dt><dd>$14.99</dd></dl>');
    const host = observer();
    const before = await host.observe({ sessionId: 'ses_a' });
    const value = byLabel(before, '$14.99');
    (root.querySelector('dt') as HTMLElement).textContent = 'Tax';
    expect(host.resolve(ref(before, value))).toEqual({ ok: false, reason: 'signature_changed' });
    const after = await host.observe({ sessionId: 'ses_a' });
    expect(byLabel(after, '$14.99').text).toBe(value.text);
    expect(byLabel(after, '$14.99').contexts).toEqual(['Tax']);
  });

  test('a remote definition term is not guessed beyond bounded sibling lookup', async () => {
    mountHtml(
      `<dl><dt>Shared term</dt>${Array.from({ length: 80 }, (_, index) => `<dd>Value ${index}</dd>`).join('')}</dl>`
    );
    const snapshot = await observer().observe({
      sessionId: 'ses_a',
      options: { includeOffscreen: true },
    });
    expect(byLabel(snapshot, 'Value 0').contexts).toEqual(['Shared term']);
    expect(byLabel(snapshot, 'Value 79').contexts).toBeUndefined();
    expect(byLabel(snapshot, 'Value 79').text).toBe('Value 79');
  });

  test('counts unsupported surfaces without entering them or offering actions', async () => {
    const root = mountHtml(
      '<iframe></iframe><canvas></canvas><div contenteditable="true">Editor</div><select multiple><option>Many</option></select><a href="/new" target="_blank">New</a><a href="/download" download>Download</a><div id="shadow"></div><input type="hidden">'
    );
    root
      .querySelector('#shadow')
      ?.attachShadow({ mode: 'open' })
      .append(document.createElement('button'));
    const result = await observer().observe({ sessionId: 'ses_a' });
    expect(result.unobserved).toEqual({
      iframes: 1,
      canvases: 1,
      contentEditable: 1,
      multiSelects: 1,
      externalTargets: 2,
      shadowRoots: 1,
    });
    expect(result.elements).toHaveLength(0);
    expect(result.text).not.toContain('Editor');
  });

  test('skips hidden, inert and zero-size elements and supports explicit offscreen observation', async () => {
    const root = mountHtml(
      '<button hidden>Hidden</button><div inert><button>Inert</button></div><button style="visibility:hidden">Invisible</button><button id="off">Offscreen</button><button id="zero">Zero</button><button>Visible</button>'
    );
    setBox(root.querySelector('#off') as HTMLElement, { top: 1000 });
    setBox(root.querySelector('#zero') as HTMLElement, { top: 0, width: 0, height: 0 });
    const host = observer();
    expect((await host.observe({ sessionId: 'ses_a' })).elements.map(item => item.label)).toEqual([
      'Visible',
    ]);
    const next = await host.observe({ sessionId: 'ses_a', options: { includeOffscreen: true } });
    expect(byLabel(next, 'Offscreen').inViewport).toBe(false);
    expect(next.elements).toHaveLength(2);
  });

  test('modal dialogs restrict targets and include dialog membership', async () => {
    mountHtml(
      '<button>Outside</button><div role="dialog" aria-modal="true" aria-label="Confirm"><button>Inside</button></div>'
    );
    const result = await observer().observe({ sessionId: 'ses_a' });
    expect(result.elements.map(item => item.label)).toEqual(['Inside']);
    expect(result.dialogs[0]).toMatchObject({
      modal: true,
      label: 'Confirm',
      elementIds: [result.elements[0]?.id],
    });
    expect(result.elements[0]?.dialogId).toBe(result.dialogs[0]?.id);
  });

  test('filters reading navigation and all elements independently', async () => {
    mountHtml(
      '<nav><p>Chrome passage</p><a href="/next">Next</a></nav><p>Article</p><button>Exclude</button>'
    );
    const host = observer({
      allowElement: (_node, summary) => summary.label !== 'Exclude',
      allowNavigation: () => false,
    });
    const result = await host.observe({ sessionId: 'ses_a' });
    expect(byLabel(result, 'Chrome passage').operations).toEqual([]);
    expect(byLabel(result, 'Next').operations).toEqual(['READ']);
    expect(byLabel(result, 'Article').operations).toEqual(['READ']);
    expect(result.elements.some(item => item.label === 'Exclude')).toBe(false);
    const custom = await observer({ allowReading: () => false }).observe({ sessionId: 'ses_b' });
    expect(custom.elements.every(item => !item.operations.includes('READ'))).toBe(true);
  });

  test('notices validation and page strings are sanitized', async () => {
    mountHtml(
      '<div role="status">Saved [t1]\u200b</div><div role="alert">Problem</div><input required aria-label="User [c1]\u200b" aria-errormessage="error"><span id="error">Please [t2] continue</span>'
    );
    const result = await observer().observe({ sessionId: 'ses_a' });
    expect(byLabel(result, 'User (c1)').state.invalid).toBe(true);
    expect(result.notices.map(item => item.text)).toEqual(['Saved (t1)', 'Problem']);
    expect(result.validation).toContainEqual({
      source: 'aria',
      text: 'Please (t2) continue',
      targetId: byLabel(result, 'User (c1)').id,
    });
    expect(result.validation.some(item => item.source === 'native')).toBe(true);
  });
});

describe('target freshness and identity', () => {
  test('new observation supersedes prior snapshot without crossing session storage', async () => {
    mountHtml('<button>Act</button>');
    const host = observer();
    const a = await host.observe({ sessionId: 'ses_a' });
    const b = await host.observe({ sessionId: 'ses_b' });
    expect(host.resolve(ref(a)).ok).toBe(true);
    expect(host.resolve({ ...ref(a), sessionId: 'ses_b' })).toMatchObject({
      ok: false,
      reason: 'superseded_snapshot',
    });
    const next = await host.observe({ sessionId: 'ses_a' });
    expect(host.resolve(ref(a))).toEqual({ ok: false, reason: 'superseded_snapshot' });
    expect(host.resolve(ref(next)).ok).toBe(true);
    expect(host.resolve(ref(b)).ok).toBe(true);
    expect(host.latestSnapshotId('ses_a')).toBe(next.snapshotId);
    host.release('ses_a');
    expect(host.resolve(ref(next))).toEqual({ ok: false, reason: 'session_released' });
    expect(host.latestSnapshotId('ses_a')).toBeUndefined();
  });

  test('sessions are bounded and separate observers share no target storage', async () => {
    mountHtml('<button>Act</button>');
    const host = observer({ maxSessions: 2 });
    const a = await host.observe({ sessionId: 'ses_a' });
    await host.observe({ sessionId: 'ses_b' });
    await host.observe({ sessionId: 'ses_c' });
    expect(host.resolve(ref(a))).toEqual({ ok: false, reason: 'session_released' });
    expect(observer().resolve(ref(a))).toEqual({ ok: false, reason: 'session_released' });
  });

  test('holds the original node and never searches for a replacement', async () => {
    const root = mountHtml('<button>Act</button>');
    const host = observer();
    const a = await host.observe({ sessionId: 'ses_a' });
    root.innerHTML = '<button>Act</button>';
    layoutColumn(root);
    expect(host.resolve(ref(a))).toEqual({ ok: false, reason: 'element_detached' });
    const b = await host.observe({ sessionId: 'ses_a' });
    expect(b.elements[0]?.signature).toBe(a.elements[0]?.signature);
  });

  test('state and focus do not change signatures but value changes change fingerprints', async () => {
    const root = mountHtml('<input aria-label="Name">');
    const node = root.querySelector('input') as HTMLInputElement;
    const host = observer();
    const a = await host.observe({ sessionId: 'ses_a' });
    node.focus();
    const b = await host.observe({ sessionId: 'ses_a' });
    expect(b.fingerprint).toBe(a.fingerprint);
    node.value = 'Changed';
    expect(host.resolve(ref(b)).ok).toBe(true);
    const c = await host.observe({ sessionId: 'ses_a' });
    expect(c.elements[0]?.signature).toBe(a.elements[0]?.signature);
    expect(c.fingerprint).not.toBe(b.fingerprint);
  });

  test('region names distinguish identical controls in labelled cards', async () => {
    mountHtml(
      '<article><h2>First</h2><button>Pick</button></article><article><h2>Second</h2><button>Pick</button></article>'
    );
    const result = await observer().observe({ sessionId: 'ses_a' });
    const buttons = result.elements.filter(item => item.kind === 'button');
    expect(buttons.map(item => item.region)).toEqual(['First', 'Second']);
    expect(buttons[0]?.signature).not.toBe(buttons[1]?.signature);
  });

  test('identical twins get suffixes and held node ignores a shifted suffix', async () => {
    const root = mountHtml('<button>Pick</button><button>Pick</button>');
    const host = observer();
    const first = await host.observe({ sessionId: 'ses_a' });
    expect(first.elements.map(item => item.twins)).toEqual([2, 2]);
    expect(first.elements[0]?.signature).toMatch(/\.1$/);
    expect(first.elements[1]?.signature).toMatch(/\.2$/);
    root.querySelector('button')?.remove();
    expect(host.resolve(ref(first, first.elements[1])).ok).toBe(true);
    const next = await host.observe({ sessionId: 'ses_a' });
    expect(next.elements[0]?.twins).toBeUndefined();
    expect(next.elements[0]?.signature).not.toMatch(/\./);
  });

  test.each(['href', 'formaction', 'marker', 'type', 'disabled', 'sensitive'] as const)(
    'rejects security structure drift: %s',
    async mutation => {
      const root = mountHtml(
        '<form action="/save"><a href="/next">Next</a><button>Save</button><input aria-label="Name"></form>'
      );
      const host = observer();
      const before = await host.observe({ sessionId: 'ses_a' });
      const label =
        mutation === 'href'
          ? 'Next'
          : mutation === 'type' || mutation === 'sensitive'
            ? 'Name'
            : 'Save';
      const node =
        mutation === 'href'
          ? root.querySelector('a')
          : mutation === 'type' || mutation === 'sensitive'
            ? root.querySelector('input')
            : root.querySelector('button');
      const attrs = {
        href: ['href', '/other'],
        formaction: ['formaction', '/other'],
        marker: ['data-kriya-commit', 'purchase'],
        type: ['type', 'password'],
        disabled: ['disabled', ''],
        sensitive: ['data-kriya-sensitive', 'true'],
      } as const;
      const [name, value] = attrs[mutation];
      node?.setAttribute(name, value);
      expect(host.resolve(ref(before, byLabel(before, label)))).toEqual({
        ok: false,
        reason: 'structure_changed',
      });
    }
  );

  test('a radio moved to a different native name group is structurally stale', async () => {
    const root = mountHtml('<form><input type="radio" name="first" aria-label="Choice"></form>');
    const host = observer();
    const before = await host.observe({ sessionId: 'ses_a' });
    (root.querySelector('input') as HTMLInputElement).name = 'second';
    expect(host.resolve(ref(before))).toEqual({ ok: false, reason: 'structure_changed' });
    const after = await host.observe({ sessionId: 'ses_a' });
    expect(after.elements[0]?.signature).not.toBe(before.elements[0]?.signature);
    expect(after.elements[0]?.groupId).not.toBe(before.elements[0]?.groupId);
  });

  test('rejects name changes and missing/forged target refs', async () => {
    const root = mountHtml('<button>Act</button>');
    const host = observer();
    const before = await host.observe({ sessionId: 'ses_a' });
    expect(host.resolve({ ...ref(before), signature: 'sg_forged' })).toEqual({
      ok: false,
      reason: 'signature_changed',
    });
    expect(host.resolve({ ...ref(before), targetId: 't999' })).toEqual({
      ok: false,
      reason: 'element_missing',
    });
    (root.querySelector('button') as HTMLElement).textContent = 'Different';
    expect(host.resolve(ref(before))).toEqual({ ok: false, reason: 'signature_changed' });
  });

  test.each(['/spa', '/#fragment'])('rejects SPA URL changes including fragment: %s', async url => {
    mountHtml('<button>Act</button>');
    const host = observer();
    const before = await host.observe({ sessionId: 'ses_a' });
    window.history.pushState(null, '', url);
    expect(host.resolve(ref(before))).toEqual({ ok: false, reason: 'url_changed' });
  });

  test('keeps raw URL security data even where exported URL redaction is equal', async () => {
    const root = mountHtml('<a href="/next?token=initial">Next</a>');
    const host = observer();
    const before = await host.observe({ sessionId: 'ses_a' });
    root.querySelector('a')?.setAttribute('href', '/next?token=replaced');
    expect(host.resolve(ref(before))).toEqual({ ok: false, reason: 'structure_changed' });
  });
});

describe('structural privacy and limits', () => {
  test('sensitive values never enter observation, text, options or fingerprints', async () => {
    const root = mountHtml(
      '<form><input type="password" aria-label="Password"><input autocomplete="cc-number" aria-label="Card"><input autocomplete="one-time-code" aria-label="Code"><textarea data-kriya-sensitive aria-label="Private notes"></textarea><div data-kriya-sensitive role="button" aria-label="Private action">private-content</div><select data-kriya-sensitive aria-label="Secret choice"><option value="hidden-option">hidden-option</option></select></form>'
    );
    const fields = root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea');
    fields.forEach((field, index) => {
      field.value = `planted-private-${index}`;
    });
    const host = observer();
    const before = await host.observe({ sessionId: 'ses_a' });
    const serialized = JSON.stringify(before);
    expect(serialized.includes('planted-private-')).toBe(false);
    expect(serialized.includes('private-content')).toBe(false);
    expect(serialized.includes('hidden-option')).toBe(false);
    expect(
      before.elements.every(
        item =>
          item.sensitive &&
          !item.operations.includes('READ') &&
          item.text === undefined &&
          item.state.valueTruncated === undefined
      )
    ).toBe(true);
    expect(
      before.elements
        .filter(item => item.state.value !== undefined)
        .every(item => item.state.value === TASK_REDACTED)
    ).toBe(true);
    fields.forEach(field => {
      field.value = 'another-private';
    });
    const after = await host.observe({ sessionId: 'ses_a' });
    expect(after.fingerprint).toBe(before.fingerprint);
    (fields[0] as HTMLInputElement).value = '';
    const empty = await host.observe({ sessionId: 'ses_a' });
    expect(byLabel(empty, 'Password').state.value).toBe('');
  });

  test.each(['name', 'id', 'aria-label', 'placeholder'] as const)(
    'recognizes sensitive %s metadata',
    attr => {
      const node = document.createElement('input');
      node.setAttribute(attr, 'security_code');
      expect(isSensitiveElement(node)).toBe(true);
    }
  );

  test('recognizes associated labels and caller hooks without lowering built-in sensitivity', async () => {
    const root = mountHtml(
      '<label for="pin">PIN</label><input id="pin"><input id="extra" aria-label="Extra"><input type="password" aria-label="Built in">'
    );
    const host = observer({ sensitiveSelectors: ['#extra'], isSensitive: () => false });
    const result = await host.observe({ sessionId: 'ses_a' });
    expect(result.elements.every(item => item.sensitive)).toBe(true);
    expect(
      isSensitiveElement(root.querySelector('#extra') as HTMLElement, { isSensitive: () => true })
    ).toBe(true);
    expect(
      isSensitiveElement(root.querySelector('#extra') as HTMLElement, {
        sensitiveSelectors: ['['],
      })
    ).toBe(true);
  });

  test('URL fields are absolute and scrubbed', async () => {
    window.history.replaceState(null, '', '/?token=private-fragment#secret');
    mountHtml(
      '<form action="/send?token=private-value#secret"><input aria-label="Name"><button formaction="/override?token=private-value#secret">Send</button></form><a href="http://user:pass@example.com/next?token=private-value#secret">Next</a>'
    );
    const result = await observer().observe({ sessionId: 'ses_a' });
    for (const url of [
      result.url,
      result.forms[0]?.action,
      byLabel(result, 'Send').formTarget?.action,
      byLabel(result, 'Name').formTarget?.action,
      byLabel(result, 'Next').href,
    ]) {
      expect(url).toBeDefined();
      expect(url).not.toContain('private-');
      expect(url).not.toContain('#');
      expect(url).not.toContain('user:pass');
      expect(url).toMatch(/^https?:\/\//);
    }
  });

  test.each(['href', 'action', 'formaction', 'method', 'marker'] as const)(
    'fresh signatures bind raw security identity despite redacted output: %s',
    async change => {
      const first = randomBytes(24).toString('hex');
      const second = randomBytes(24).toString('hex');
      const root = mountHtml(
        `<form action="/send?token=${first}" method="post"><button>Send</button></form><a href="/next?token=${first}#first">Next</a>`
      );
      const host = observer();
      const before = await host.observe({ sessionId: 'ses_a' });
      const label = change === 'href' ? 'Next' : 'Send';
      if (change === 'href') {
        root.querySelector('a')?.setAttribute('href', `/next?token=${second}#second`);
      }
      if (change === 'action') {
        root.querySelector('form')?.setAttribute('action', `/send?token=${second}`);
      }
      if (change === 'formaction') {
        root.querySelector('button')?.setAttribute('formaction', `/send?token=${second}`);
      }
      if (change === 'method') {
        root.querySelector('form')?.setAttribute('method', 'get');
      }
      if (change === 'marker') {
        root.querySelector('button')?.setAttribute('data-kriya-commit', 'purchase');
      }
      expect(host.resolve(ref(before, byLabel(before, label)))).toEqual({
        ok: false,
        reason: 'structure_changed',
      });
      const after = await host.observe({ sessionId: 'ses_a' });
      expect(byLabel(after, label).signature).not.toBe(byLabel(before, label).signature);
      expect(byLabel(after, label).signature).toMatch(/^sg_[a-f0-9]{16}$/);
      expect(JSON.stringify(before).includes(first)).toBe(false);
      expect(JSON.stringify(after).includes(second)).toBe(false);
      if (change === 'href') {
        expect(byLabel(after, label).href).toBe(byLabel(before, label).href);
      }
      if (change === 'action' || change === 'formaction') {
        expect(byLabel(after, label).formTarget?.action).toBe(
          byLabel(before, label).formTarget?.action
        );
      }
    }
  );

  test('caps observed values by code points and marks truncation', async () => {
    const root = mountHtml('<input aria-label="Long">');
    (root.querySelector('input') as HTMLInputElement).value = '😀'.repeat(
      TASK_LIMITS.valueChars + 2
    );
    const result = await observer().observe({ sessionId: 'ses_a' });
    expect(result.elements[0]?.state.value).toBe('😀'.repeat(TASK_LIMITS.valueChars));
    expect(result.elements[0]?.state.valueTruncated).toBe(true);
  });

  test('reports element option and page text truncation', async () => {
    mountHtml(
      `<select aria-label="Options">${Array.from({ length: TASK_LIMITS.optionsPerElement + 3 }, (_, index) => `<option>${index}</option>`).join('')}</select><p>${'a'.repeat(TASK_LIMITS.observedTextChars + 5)}</p><button>More</button>`
    );
    const result = await observer({ maxElements: 2 }).observe({ sessionId: 'ses_a' });
    expect(result.elements).toHaveLength(2);
    expect(result.truncation).toEqual({
      elementsDropped: 1,
      optionsDropped: 3,
      textTruncated: true,
    });
    expect(result.text.length).toBe(TASK_LIMITS.observedTextChars);
    expect(result.elements[1]?.text?.length).toBe(TASK_LIMITS.passageChars);
    expect(result.elements[0]?.options).toHaveLength(TASK_LIMITS.optionsPerElement);
  });

  test('scroll directions use epsilon and fingerprint changes with scrolling', async () => {
    const root = mountHtml('<div id="scroll" style="overflow:auto">Container</div>');
    const node = root.querySelector('#scroll') as HTMLElement;
    setBox(node, { top: 10, height: 100 });
    makeScrollable(node, { scrollHeight: 400, clientHeight: 100 });
    const host = observer();
    const first = await host.observe({ sessionId: 'ses_a' });
    expect(first.page.scroll.directions).toEqual(['DOWN', 'BOTTOM']);
    expect(first.elements[0]?.operations).toContain('SCROLL');
    node.scrollTop = 299;
    window.scrollTo(0, 3);
    const next = await host.observe({ sessionId: 'ses_a' });
    expect(next.page.scroll.directions).toEqual(['UP', 'TOP', 'DOWN', 'BOTTOM']);
    expect(next.elements[0]?.scroll?.directions).toEqual(['UP', 'TOP']);
    expect(next.fingerprint).not.toBe(first.fingerprint);
  });

  test('sequence respects minSequence and disabled text collection', async () => {
    mountHtml('<p>Reading</p>');
    const host = observer();
    const first = await host.observe({ sessionId: 'ses_a', minSequence: 100 });
    expect(first.sequence).toBe(101);
    const second = await host.observe({ sessionId: 'ses_a', options: { includeText: false } });
    expect(second.sequence).toBe(102);
    expect(second.text).toBe('');
    expect(second.elements[0]?.text).toBe('Reading');
  });

  test('abort ends settling promptly without making a cancelled snapshot resolvable', async () => {
    mountHtml('<button>Act</button>');
    const host = observer();
    const controller = new AbortController();
    const pending = host.observe(
      { sessionId: 'ses_a', options: { settle: { quietMs: 10000, maxMs: 20000 } } },
      controller.signal
    );
    controller.abort();
    const result = await pending;
    expect(result.elements).toEqual([]);
    expect(host.latestSnapshotId('ses_a')).toBeUndefined();
  });
});
