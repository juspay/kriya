/** @jest-environment node */
import { TASK_REDACTED } from '@/types';
import { createTaskAgent } from '@/agent/TaskAgent';
import { createTaskPolicy } from '@/agent/policy';
import { hmacSha256Hex, stableStringify } from '@/utils/hash';
import {
  buildCandidates,
  candidateViews,
  materializeArgument,
  goalRefMatches,
} from '@/agent/resolver';
import { goalRequirementKey, goalRequirementHolds } from '@/agent/requirements';
import {
  deciderOk,
  deciderFail,
  makeCapabilities,
  makeFakeHost,
  makeFakeDecider,
  makeObservation,
  makeTextField,
  makeSubmitButton,
  makeForm,
  makeSelectField,
  makeElement,
  makePassage,
  makeCompletionDecision,
  makeCheckbox,
  makeOutcome,
  makeLink,
  makeRequest,
} from './helpers/agent-fixtures';
import { action, terminal, chooseCandidate } from './helpers/task-agent-contract';
import type {
  TaskActionDecision,
  TaskArgumentDecision,
  TaskChooseArgumentRequest,
  TaskCheckpoint,
  TaskCompletionDecision,
} from '@/types';

describe('goal requirements independent of executed postconditions', () => {
  test('keeps supplied option codes through the first candidate cap and into the model view', () => {
    const options = Array.from({ length: 80 }, (_, index) => ({
      id: `t1.${index}`,
      label: `Region ${index}`,
      value: `R${index}`,
      selected: false,
      disabled: false,
    }));
    const element = makeSelectField({ options });
    const pool = buildCandidates({
      goal: 'Use the supplied region.',
      operation: 'SELECT',
      slot: 'option',
      element,
      observation: makeObservation({ elements: [element] }),
      capabilities: makeCapabilities(),
      leaves: [{ path: 'address.region', value: 'R79', scalar: 'string', sensitive: false }],
      resolvers: [],
      origins: [],
      limit: 64,
    });
    expect(pool.candidates).toHaveLength(64);
    expect(candidateViews(pool).find(candidate => candidate.code === 'R79')).toMatchObject({
      label: 'Region 79',
    });
  });
  test('a supplied optional value is entered before submission; an unrelated field is untouched', async () => {
    const phone = makeTextField({
      id: 'phone',
      label: 'Phone (optional)',
      formId: 'f1',
      inputName: 'profile.phone',
      inputType: 'tel',
      state: { value: '' },
    });
    const unrelated = makeTextField({
      id: 'newsletter',
      label: 'Newsletter email',
      formId: 'f2',
      inputName: 'newsletter.email',
    });
    const submit = makeSubmitButton({ formId: 'f1' });
    const before = makeObservation({
      elements: [phone, unrelated, submit],
      forms: [makeForm({ id: 'f1', fieldIds: [phone.id], submitterIds: [submit.id] })],
    });
    const after = makeObservation({
      ...before,
      elements: [
        { ...phone, state: { ...phone.state, value: '+1 206 555 0148' } },
        unrelated,
        submit,
      ],
    });
    const host = makeFakeHost({ observations: [before, before, before, after, after, after] });
    const argumentReply = (request: TaskChooseArgumentRequest) => {
      if (request.purpose === 'activation')
        return chooseCandidate(request, candidate => candidate.source === 'protocol');
      return request.target?.id === phone.id
        ? chooseCandidate(request, candidate => candidate.source === 'input')
        : deciderOk('argument', { kind: 'none_appropriate' as const, confidence: 0.99 });
    };
    const fake = makeFakeDecider({
      chooseAction: [
        deciderOk('action', terminal('DONE')),
        deciderOk('action', action('SUBMIT', submit.id)),
        deciderOk('action', action('FILL', phone.id)),
        deciderOk('action', action('SUBMIT', submit.id)),
        deciderOk('action', terminal('BLOCKED')),
      ],
      chooseArgument: [argumentReply, argumentReply, argumentReply, argumentReply],
      classifyCommitment: [
        deciderOk('commitment', {
          commitment: 'FORM_SUBMIT',
          confidence: 0.99,
          agreement: 'agreed',
        }),
      ],
    });
    const agent = createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    });
    const result = await agent.run(
      makeRequest({
        goal: 'Fill my supplied shipping details and open the review.',
        options: { captureTrace: true },
        inputs: { profile: { phone: '+1 206 555 0148' } },
        authorization: { effects: ['form_submit'] },
      })
    );
    expect(fake.calls.chooseAction[0]?.request.offers.operations).not.toContain('DONE');
    expect(fake.calls.chooseAction[1]?.request.offers.targets.SUBMIT).toEqual([]);
    expect(fake.calls.chooseArgument.every(call => call.request.purpose !== undefined)).toBe(true);
    expect(fake.calls.chooseAction[0]?.request.offers.targets.FILL).not.toContain(unrelated.id);
    expect(host.calls.execute.map(request => request.command.operation)).toEqual([
      'FILL',
      'SUBMIT',
    ]);
    expect(host.calls.execute[0]?.command).toMatchObject({ value: '+1 206 555 0148' });
    expect((result.trace ?? []).filter(event => event.type === 'planning')).toEqual([
      expect.objectContaining({
        source: 'goal_requirement',
        operation: 'FILL',
        targetId: phone.id,
        requirementConfidence: 0.99,
      }),
    ]);
    expect((result.trace ?? []).findIndex(event => event.type === 'planning')).toBeLessThan(
      (result.trace ?? []).findIndex(event => event.type === 'decision')
    );
  });

  test('code preparation retains policy denial and does not submit a required form', async () => {
    const field = makeTextField({ label: 'Telephone', formId: 'f1', state: { value: '' } });
    const submit = makeSubmitButton({ formId: 'f1' });
    const observation = makeObservation({
      elements: [field, submit],
      forms: [makeForm({ id: 'f1', fieldIds: [field.id], submitterIds: [submit.id] })],
    });
    const host = makeFakeHost({ observations: [observation] });
    const fake = makeFakeDecider({
      chooseArgument: [
        request => chooseCandidate(request, candidate => candidate.source === 'input'),
        request => chooseCandidate(request, candidate => candidate.source === 'protocol'),
      ],
    });
    const policy = createTaskPolicy();
    const agent = createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
      policy: {
        ...policy,
        evaluate: input => ({
          verdict: 'deny',
          effects: input.effects,
          reason: 'operation_not_allowed',
        }),
      },
    });
    const result = await agent.run(
      makeRequest({
        goal: 'Use my telephone and submit the form.',
        inputs: { phone: '555-0182' },
        options: { captureTrace: true },
      })
    );
    expect(result.status).toBe('blocked');
    expect(host.calls.execute).toHaveLength(0);
    expect(fake.calls.chooseAction).toHaveLength(0);
    expect((result.trace ?? []).filter(event => event.type === 'planning')).toEqual([
      expect.objectContaining({ operation: 'FILL', targetId: field.id }),
    ]);
  });

  test('a changed view after purchase probes completion once and honors an uncertain model verdict', async () => {
    const buy = makeElement({
      label: 'Place order',
      commitHints: [{ class: 'PURCHASE', basis: 'declared_marker' }],
    });
    const before = makeObservation({ elements: [buy] });
    const after = makeObservation({
      ...before,
      url: before.url + '/confirmation',
      fingerprint: 'pf_confirmation',
      elements: [makePassage({ label: 'Order receipt', text: 'Order R42 was created.' })],
    });
    const host = makeFakeHost({ observations: [before, after, after, after] });
    const fake = makeFakeDecider({
      chooseAction: [
        deciderOk('action', action('CLICK', buy.id)),
        deciderOk('action', terminal('BLOCKED')),
      ],
      classifyCommitment: [
        deciderOk('commitment', { commitment: 'PURCHASE', confidence: 0.99, agreement: 'single' }),
      ],
      verifyCompletion: [
        deciderOk(
          'completion',
          makeCompletionDecision({ verdict: 'UNCERTAIN', evidenceTargetIds: [] })
        ),
      ],
    });
    const result = await createTaskAgent({ host: host.host, decider: fake.decider }).run(
      makeRequest({
        goal: 'Place the order.',
        authorization: { effects: ['purchase'] },
        options: { captureTrace: true, confidence: { commitment: 0.81 } },
      })
    );
    expect(fake.calls.verifyCompletion).toHaveLength(1);
    expect(fake.calls.classifyCommitment[0]?.request.confidenceFloor).toBe(0.81);
    expect(fake.calls.chooseAction).toHaveLength(2);
    expect(result.status).toBe('blocked');
    expect(host.calls.execute).toHaveLength(1);
    expect((result.trace ?? []).filter(event => event.type === 'done_gate')).toEqual([
      expect.objectContaining({ passed: false }),
    ]);
  });

  test.each(['applied', 'uncertain'] as const)(
    'unchanged checked controls retain %s dispatch uncertainty, form scope and signed resume context',
    async effect => {
      const consent = makeCheckbox({
        id: 'consent',
        label: 'Send order updates',
        formId: 'f1',
        state: { checked: true },
      });
      const footer = makeCheckbox({
        id: 'footer',
        label: 'Unrelated signup',
        formId: 'f2',
        state: { checked: false },
      });
      const submit = makeSubmitButton({ formId: 'f1' });
      const before = makeObservation({
        elements: [consent, footer, submit],
        forms: [makeForm({ id: 'f1', fieldIds: [consent.id], submitterIds: [submit.id] })],
      });
      const later = makeTextField({ id: 'later', label: 'Missing detail', state: { value: '' } });
      const after = makeObservation({
        ...before,
        elements: [later],
        forms: [],
        fingerprint: 'pf_later',
      });
      const host = makeFakeHost({
        observations: [before, after, after, after],
        outcomes: [makeOutcome('navigated', effect)],
      });
      const fake = makeFakeDecider({
        chooseAction: [
          deciderOk('action', action('SUBMIT', submit.id)),
          deciderOk('action', terminal('BLOCKED')),
          deciderOk('action', terminal('BLOCKED')),
        ],
        chooseArgument: [
          request => chooseCandidate(request, candidate => candidate.label === 'Set checked'),
          deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 }),
          request => chooseCandidate(request, candidate => candidate.source === 'protocol'),
          deciderOk('argument', { kind: 'required_unavailable', confidence: 0.99 }),
          deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 }),
        ],
        classifyCommitment: [
          deciderOk('commitment', {
            commitment: 'FORM_SUBMIT',
            confidence: 0.99,
            agreement: 'single',
          }),
        ],
      });
      const agent = createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      });
      const result = await agent.run(
        makeRequest({
          goal: 'Submit with order updates enabled.',
          authorization: { effects: ['form_submit'] },
        })
      );
      if (result.status !== 'needs_input') throw new Error('Expected missing detail pause.');
      expect(result.ledger[0]?.effect).toBe(effect);
      expect(result.checkpoint.primarySubmissionSeq).toBe(1);
      expect(result.checkpoint.submittedControls).toEqual([
        {
          ledgerSeq: 1,
          effect,
          origin: before.origin,
          label: consent.label,
          kind: consent.kind,
          checked: true,
        },
      ]);
      await agent.resume({
        checkpoint: result.checkpoint,
        resolution: { kind: 'inputs', inputs: { detail: 'Provided' } },
      });
      expect(
        fake.calls.chooseArgument[fake.calls.chooseArgument.length - 1]?.request.submittedControls
      ).toEqual(result.checkpoint.submittedControls);
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(['SUBMIT']);
    }
  );

  test.each(['new_document', 'same_document', 'lasting_effect'] as const)(
    'uncertain preparation recovery is restricted to proven absence in a fresh authoritative document: %s',
    async variant => {
      const field = makeTextField({ label: 'Search', state: { value: '' } });
      const before = makeObservation({ elements: [field] });
      const after = makeObservation({
        ...before,
        documentId: variant === 'same_document' ? before.documentId : 'doc_ffffffffffff',
        fingerprint: variant === 'same_document' ? before.fingerprint : 'pf_replaced',
      });
      const filled = makeObservation({
        ...after,
        elements: [{ ...field, state: { ...field.state, value: 'tea' } }],
        fingerprint: 'pf_filled',
      });
      const host = makeFakeHost({
        observations: [before, after, filled, filled],
        outcomes: [makeOutcome('navigated', 'uncertain')],
      });
      const fake = makeFakeDecider({
        chooseAction: [deciderOk('action', terminal('BLOCKED'))],
        chooseArgument: [
          request => chooseCandidate(request, candidate => candidate.source === 'input'),
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
        ...(variant === 'lasting_effect'
          ? { policy: createTaskPolicy({ promoteEffects: { input: 'account_change' } }) }
          : {}),
      }).run(
        makeRequest({
          goal: 'Search using my supplied query.',
          inputs: { query: 'tea' },
          authorization: { effects: ['account_change'] },
        })
      );
      expect(result.status).toBe('blocked');
      expect(host.calls.execute).toHaveLength(variant === 'new_document' ? 2 : 1);
      expect(host.calls.execute.every(request => request.command.operation === 'FILL')).toBe(true);
      if (variant === 'new_document') {
        expect(host.calls.execute[0]?.scope.documentId).not.toBe(
          host.calls.execute[1]?.scope.documentId
        );
      }
    }
  );

  test.each([0, 2])(
    'uncertain applicability is rejected without caching irrelevant: budget %s',
    async maxInvalidDecisions => {
      const field = makeTextField({ label: 'Search', state: { value: '' } });
      const before = makeObservation({ elements: [field] });
      const after = makeObservation({
        ...before,
        elements: [{ ...field, state: { ...field.state, value: 'tea' } }],
        fingerprint: 'pf_search',
      });
      const host = makeFakeHost({ observations: [before, before, after, after] });
      const fake = makeFakeDecider({
        chooseArgument: [
          deciderOk('argument', { kind: 'uncertain_requirement', confidence: 0.99 }),
          request => chooseCandidate(request, candidate => candidate.source === 'input'),
        ],
        chooseAction: [deciderOk('action', terminal('BLOCKED'))],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(
        makeRequest({
          goal: 'Search for my supplied query.',
          inputs: { query: 'tea' },
          options: { budgets: { maxInvalidDecisions } },
        })
      );
      expect(result.status).toBe('blocked');
      expect(host.calls.execute).toHaveLength(maxInvalidDecisions === 0 ? 0 : 1);
      expect(fake.calls.chooseArgument).toHaveLength(maxInvalidDecisions === 0 ? 1 : 2);
      if (maxInvalidDecisions === 0) expect(fake.calls.chooseAction).toHaveLength(0);
    }
  );

  test.each([false, true])(
    'required missing input pauses without wandering, after related expansion: %s',
    async expandFirst => {
      const field = makeTextField({
        label: 'Search',
        region: 'Search panel',
        state: { value: '' },
      });
      const open = makeElement({
        id: 'open',
        label: 'Open search options',
        region: field.region,
        state: { expanded: false },
      });
      const before = makeObservation({ elements: expandFirst ? [field, open] : [field] });
      const after = makeObservation({
        ...before,
        elements: [field, { ...open, state: { ...open.state, expanded: true } }],
        fingerprint: 'pf_opened',
      });
      const host = makeFakeHost({ observations: [before, after, after] });
      const fake = makeFakeDecider({
        chooseArgument: [deciderOk('argument', { kind: 'required_unavailable', confidence: 0.99 })],
        chooseAction: expandFirst ? [deciderOk('action', action('CLICK', open.id))] : [],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(makeRequest({ goal: 'Search for the item I have in mind.' }));
      expect(result.status).toBe('needs_input');
      expect(fake.calls.chooseAction).toHaveLength(expandFirst ? 1 : 0);
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(
        expandFirst ? ['CLICK'] : []
      );
    }
  );

  test('missing dependent options do not pause before a confident parent country selection', async () => {
    const country = makeSelectField({
      id: 'country',
      label: 'Country',
      options: [
        { id: 'country.us', label: 'United States', value: 'US', selected: true, disabled: false },
        { id: 'country.ca', label: 'Canada', value: 'CA', selected: false, disabled: false },
      ],
      state: { value: 'US' },
    });
    const region = makeSelectField({
      id: 'region',
      label: 'Province',
      options: [
        { id: 'region.us', label: 'Alabama', value: 'AL', selected: false, disabled: false },
      ],
      state: { value: '' },
    });
    const before = makeObservation({ elements: [country, region] });
    const chosenCountry = {
      ...country,
      state: { ...country.state, value: 'CA' },
      options: country.options?.map(option => ({ ...option, selected: option.value === 'CA' })),
    };
    const canadaRegion = {
      ...region,
      options: [
        { id: 'region.ca', label: 'Ontario', value: 'ON', selected: false, disabled: false },
      ],
    };
    const afterCountry = makeObservation({
      ...before,
      elements: [chosenCountry, canadaRegion],
      fingerprint: 'pf_country',
    });
    const afterRegion = makeObservation({
      ...afterCountry,
      elements: [
        chosenCountry,
        {
          ...canadaRegion,
          state: { ...region.state, value: 'ON' },
          options: canadaRegion.options.map(option => ({ ...option, selected: true })),
        },
      ],
      fingerprint: 'pf_region',
    });
    const host = makeFakeHost({ observations: [before, afterCountry, afterRegion, afterRegion] });
    const fake = makeFakeDecider({
      chooseArgument: [
        request => chooseCandidate(request, candidate => candidate.label === 'Canada'),
        deciderOk('argument', { kind: 'required_unavailable', confidence: 0.99 }),
        request => chooseCandidate(request, candidate => candidate.label === 'Ontario'),
      ],
      classifyCommitment: [
        deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
      ],
      chooseAction: [deciderOk('action', terminal('BLOCKED'))],
    });
    const result = await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(makeRequest({ goal: 'Use Ontario in Canada.' }));
    expect(result.status).toBe('blocked');
    expect(host.calls.execute.map(request => request.command.operation)).toEqual([
      'SELECT',
      'SELECT',
    ]);
    expect(fake.calls.chooseArgument).toHaveLength(3);
  });

  test.each([false, true])(
    'main navigation defers missing footer input only while bounded decisions can progress: %s',
    async navigate => {
      const field = makeTextField({
        label: 'Needed detail',
        landmark: 'footer',
        state: { value: '' },
      });
      const link = makeLink({
        id: 'next',
        label: 'Another view',
        landmark: 'main',
        region: field.region,
      });
      const before = makeObservation({ elements: [field, link] });
      const after = makeObservation({
        ...before,
        title: 'Next view',
        elements: [makePassage()],
        fingerprint: 'pf_next',
      });
      const invalid: TaskActionDecision = {
        operation: 'CLICK',
        target: { kind: 'none_appropriate' },
        confidence: 0.99,
        operationConfidence: 0.99,
      };
      const host = makeFakeHost({
        observations: navigate ? [before, before, after, after] : [before],
      });
      const fake = makeFakeDecider({
        chooseArgument: [deciderOk('argument', { kind: 'required_unavailable', confidence: 0.99 })],
        chooseAction: navigate
          ? [
              deciderOk('action', invalid),
              deciderOk('action', action('NAVIGATE', link.id)),
              deciderOk('action', terminal('BLOCKED')),
            ]
          : [
              deciderOk('action', invalid),
              deciderOk('action', invalid),
              deciderOk('action', invalid),
            ],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(
        makeRequest({
          goal: 'Use the required detail.',
          options: { budgets: { maxInvalidDecisions: 2 } },
        })
      );
      expect(result.status).toBe(navigate ? 'blocked' : 'needs_input');
      expect(fake.calls.chooseAction).toHaveLength(3);
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(
        navigate ? ['NAVIGATE'] : []
      );
    }
  );

  test.each(['BLOCKED', 'SUBMIT'] as const)(
    'one ready required form narrows real model choice and retains purchase approval: %s',
    async choice => {
      const field = makeTextField({
        label: 'Contact email',
        formId: 'f1',
        state: { value: 'buyer@example.test' },
      });
      const submit = makeSubmitButton({
        label: 'Place the order',
        formId: 'f1',
        commitHints: [{ class: 'PURCHASE', basis: 'declared_marker' }],
      });
      const back = makeLink({ id: 'back', label: 'Return to previous view' });
      const passage = makePassage({ id: 'notice' });
      const observation = makeObservation({
        elements: [field, submit, back, passage],
        forms: [makeForm({ id: 'f1', fieldIds: [field.id], submitterIds: [submit.id] })],
      });
      const host = makeFakeHost({ observations: [observation] });
      const fake = makeFakeDecider({
        chooseArgument: [
          request => chooseCandidate(request, candidate => candidate.source === 'input'),
          request => chooseCandidate(request, candidate => candidate.source === 'protocol'),
        ],
        chooseAction:
          choice === 'BLOCKED'
            ? [deciderOk('action', terminal('BLOCKED'))]
            : [
                deciderOk('action', action('READ', passage.id)),
                deciderOk('action', action('SUBMIT', submit.id)),
              ],
        classifyCommitment: [
          deciderOk('commitment', {
            commitment: 'PURCHASE',
            confidence: 0.99,
            agreement: 'single',
          }),
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(
        makeRequest({
          goal: 'Buy using my supplied contact.',
          inputs: { email: 'buyer@example.test' },
          authorization: { effects: ['form_submit'] },
        })
      );
      expect(result.status).toBe(choice === 'BLOCKED' ? 'blocked' : 'awaiting_approval');
      const offers = fake.calls.chooseAction[0]?.request.offers;
      expect(offers?.operations).toEqual(expect.arrayContaining(['SUBMIT', 'READ', 'BLOCKED']));
      expect(offers?.operations).not.toContain('NAVIGATE');
      expect(offers?.targets.SUBMIT).toEqual([submit.id]);
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(
        choice === 'BLOCKED' ? [] : ['READ']
      );
      expect(fake.calls.chooseAction).toHaveLength(choice === 'BLOCKED' ? 1 : 2);
    }
  );

  test.each([false, true])(
    'one exclusive-group judgment never alternates delivery choices; duplicate values: %s',
    async duplicateValues => {
      const standard = makeCheckbox({
        id: 'standard',
        controlId: 'ctl_standard',
        kind: 'radio',
        inputType: 'radio',
        inputName: 'delivery',
        groupId: 'f1:delivery',
        formId: 'f1',
        label: duplicateValues ? 'Delivery choice' : 'Standard',
        state: { value: duplicateValues ? 'on' : 'standard', checked: true },
      });
      const express = makeCheckbox({
        ...standard,
        id: 'express',
        controlId: 'ctl_express',
        label: duplicateValues ? 'Delivery choice' : 'Express',
        state: { ...standard.state, value: duplicateValues ? 'on' : 'express', checked: false },
      });
      const standardLabel = { ...standard, id: 'standard_label' };
      const expressLabel = { ...express, id: 'express_label' };
      const before = makeObservation({
        elements: [standard, standardLabel, express, expressLabel],
      });
      const after = makeObservation({
        ...before,
        fingerprint: 'pf_express',
        elements: before.elements.map(element => ({
          ...element,
          state: { ...element.state, checked: element.controlId === express.controlId },
        })),
      });
      const host = makeFakeHost({ observations: [before, after, after] });
      const fake = makeFakeDecider({
        chooseArgument: [
          request => chooseCandidate(request, candidate => candidate.id === express.id),
        ],
        chooseAction: [deciderOk('action', terminal('BLOCKED'))],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(
        makeRequest({
          goal: duplicateValues ? 'Choose the second delivery option.' : 'Use Express delivery.',
        })
      );
      expect(result.status).toBe('blocked');
      expect(fake.calls.chooseArgument).toHaveLength(1);
      expect(fake.calls.chooseArgument[0]?.request.purpose).toBe('group');
      expect(
        fake.calls.chooseArgument[0]?.request.candidates.map(candidate => candidate.id)
      ).toEqual([standard.id, express.id]);
      expect(host.calls.execute).toHaveLength(1);
      expect(host.calls.execute[0]?.command).toMatchObject({
        operation: 'SET_CHECKED',
        target: { targetId: express.id },
        checked: true,
      });
      expect(
        fake.calls.chooseAction[0]?.request.goalRequirements?.every(view => view.satisfied)
      ).toBe(true);
      expect(fake.calls.chooseAction[0]?.request.offers.targets.SET_CHECKED).toEqual([]);
    }
  );

  test.each(['keep_current', 'none_appropriate'] as const)(
    'group %s preserves a single current choice with no dispatch',
    async kind => {
      const first = makeCheckbox({
        id: 'first',
        controlId: 'ctl_first',
        kind: 'radio',
        inputType: 'radio',
        inputName: 'choice',
        groupId: 'f1:choice',
        state: { checked: true, value: 'first' },
      });
      const second = makeCheckbox({
        ...first,
        id: 'second',
        controlId: 'ctl_second',
        label: 'Other choice',
        state: { ...first.state, checked: false, value: 'second' },
      });
      const passage = makePassage();
      const host = makeFakeHost({
        observations: [makeObservation({ elements: [first, second, passage] })],
      });
      const fake = makeFakeDecider({
        chooseArgument: [deciderOk('argument', { kind, confidence: 0.99 })],
        chooseAction: [deciderOk('action', terminal('DONE'))],
        verifyCompletion: [
          deciderOk(
            'completion',
            makeCompletionDecision({
              evidenceTargetIds: [kind === 'keep_current' ? first.id : passage.id],
            })
          ),
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(
        makeRequest({
          goal:
            kind === 'keep_current' ? 'Keep the current selection.' : 'Read the shipping policy.',
        })
      );
      expect(result.status).toBe('completed');
      expect(host.calls.execute).toHaveLength(0);
      expect(fake.calls.chooseArgument).toHaveLength(1);
    }
  );

  test.each(['uncertain_requirement', 'foreign'] as const)(
    'unsupported group judgment %s cannot mutate a control',
    async kind => {
      const first = makeCheckbox({
        id: 'first',
        controlId: 'ctl_first',
        kind: 'radio',
        inputType: 'radio',
        inputName: 'choice',
        groupId: 'f1:choice',
        state: { checked: true },
      });
      const host = makeFakeHost({ observations: [makeObservation({ elements: [first] })] });
      const fake = makeFakeDecider({
        chooseArgument: [
          deciderOk(
            'argument',
            kind === 'foreign'
              ? { kind: 'candidate', candidateId: 'unobserved', confidence: 0.99 }
              : { kind: 'uncertain_requirement', confidence: 0.99 }
          ),
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(
        makeRequest({
          goal: 'Use the selected option.',
          options: { budgets: { maxInvalidDecisions: 0 } },
        })
      );
      expect(result.status).toBe('blocked');
      expect(host.calls.execute).toHaveLength(0);
      expect(fake.calls.chooseAction).toHaveLength(0);
    }
  );

  test('unnamed independent radios never become one exclusive group', async () => {
    const first = makeCheckbox({
      id: 'first',
      controlId: 'ctl_first',
      kind: 'radio',
      inputType: 'radio',
      inputName: '',
      state: { checked: false },
    });
    const second = makeCheckbox({
      ...first,
      id: 'second',
      controlId: 'ctl_second',
      label: 'Independent second option',
    });
    const before = makeObservation({ elements: [first, second] });
    const afterFirst = makeObservation({
      ...before,
      elements: [{ ...first, state: { ...first.state, checked: true } }, second],
      fingerprint: 'pf_first',
    });
    const afterBoth = makeObservation({
      ...afterFirst,
      elements: afterFirst.elements.map(element => ({
        ...element,
        state: { ...element.state, checked: true },
      })),
      fingerprint: 'pf_both',
    });
    const host = makeFakeHost({ observations: [before, afterFirst, afterBoth, afterBoth] });
    const fake = makeFakeDecider({
      chooseArgument: [
        request => chooseCandidate(request, candidate => candidate.label === 'Set checked'),
        request => chooseCandidate(request, candidate => candidate.label === 'Set checked'),
      ],
      chooseAction: [deciderOk('action', terminal('BLOCKED'))],
      classifyCommitment: [
        deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
      ],
    });
    await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(makeRequest({ goal: 'Check both independent options.' }));
    expect(fake.calls.chooseArgument.map(call => call.request.purpose)).toEqual([
      'requirement',
      'requirement',
    ]);
    expect(host.calls.execute.map(request => request.command.operation)).toEqual([
      'SET_CHECKED',
      'SET_CHECKED',
    ]);
  });

  test('historical verified quantity remains in action context after its form is submitted and left', async () => {
    const quantity = makeTextField({
      id: 'quantity',
      label: 'Quantity',
      inputType: 'number',
      formId: 'f1',
      state: { value: '2' },
    });
    const submit = makeSubmitButton({ label: 'Apply quantity', formId: 'f1' });
    const before = makeObservation({
      elements: [quantity, submit],
      forms: [makeForm({ id: 'f1', fieldIds: [quantity.id], submitterIds: [submit.id] })],
    });
    const changed = makeObservation({
      ...before,
      fingerprint: 'pf_one',
      elements: [{ ...quantity, state: { ...quantity.state, value: '1' } }, submit],
    });
    const next = makeObservation({
      ...changed,
      title: 'Next step',
      documentId: 'doc_ffffffffffff',
      url: before.url + '/next',
      fingerprint: 'pf_next',
      elements: [makePassage()],
      forms: [],
    });
    const host = makeFakeHost({
      observations: [before, changed, next, next],
      outcomes: [
        makeOutcome('applied', 'applied', {
          readback: {
            kind: 'fill',
            tag: 'input',
            inputType: 'number',
            length: 1,
            empty: false,
            changed: true,
            matched: true,
          },
        }),
        makeOutcome('navigated', 'applied'),
      ],
    });
    const fake = makeFakeDecider({
      chooseArgument: [
        request => chooseCandidate(request, candidate => candidate.preview === '1'),
        request => chooseCandidate(request, candidate => candidate.source === 'protocol'),
      ],
      chooseAction: [
        deciderOk('action', action('SUBMIT', submit.id)),
        deciderOk('action', terminal('BLOCKED')),
      ],
      classifyCommitment: [
        deciderOk('commitment', {
          commitment: 'FORM_SUBMIT',
          confidence: 0.99,
          agreement: 'single',
        }),
      ],
    });
    await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(
      makeRequest({
        goal: 'Use one unit and continue.',
        authorization: { effects: ['form_submit'] },
      })
    );
    expect(fake.calls.chooseAction[1]?.request.expected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Quantity',
          expected: '1',
          status: 'retired',
          retiredBy: 'submit',
        }),
      ])
    );
    expect(host.calls.execute.map(request => request.command.operation)).toEqual([
      'FILL',
      'SUBMIT',
    ]);
  });

  test('an unrelated select cannot erase a confirmed missing email requirement', async () => {
    const email = makeTextField({
      label: 'Email address',
      inputType: 'email',
      formId: 'f1',
      region: 'Contact information',
      state: { value: '' },
    });
    const region = makeSelectField({
      id: 'region',
      label: 'Region',
      formId: 'f1',
      region: 'Delivery address',
      options: [
        { id: 'region.wa', label: 'Washington', value: 'WA', selected: false, disabled: false },
      ],
      state: { value: '' },
    });
    const before = makeObservation({ elements: [email, region] });
    const after = makeObservation({
      ...before,
      fingerprint: 'pf_region',
      elements: [
        email,
        {
          ...region,
          state: { ...region.state, value: 'WA' },
          options: region.options?.map(option => ({ ...option, selected: true })),
        },
      ],
    });
    const host = makeFakeHost({ observations: [before, after, after] });
    const fake = makeFakeDecider({
      chooseArgument: [
        deciderOk('argument', { kind: 'required_unavailable', confidence: 0.99 }),
        request => chooseCandidate(request, candidate => candidate.label === 'Washington'),
        deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 }),
      ],
      classifyCommitment: [
        deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
      ],
    });
    const result = await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(makeRequest({ goal: 'Use my delivery information.' }));
    expect(result.status).toBe('needs_input');
    expect(fake.calls.chooseArgument).toHaveLength(2);
    expect(fake.calls.chooseAction).toHaveLength(0);
    expect(host.calls.execute.map(request => request.command.operation)).toEqual(['SELECT']);
  });

  test.each([1, 3])(
    'a speculative target requires a second real action decision within model budget %s',
    async maxModelCalls => {
      const passage = makePassage();
      const button = makeElement();
      const host = makeFakeHost({
        observations: [makeObservation({ elements: [passage, button] })],
      });
      const invalid: TaskActionDecision = {
        operation: 'CLICK',
        target: { kind: 'none_appropriate' },
        confidence: 0.99,
        operationConfidence: 0.99,
      };
      const second: TaskActionDecision = {
        ...action('READ', passage.id),
        confidence: 0.88,
        operationConfidence: 0.88,
        targetConfidence: 0.88,
      };
      const fake = makeFakeDecider({
        chooseAction: [
          deciderOk('action', invalid, {
            answers: {
              click_target: { choice: 'NONE_APPROPRIATE', confidence: 0.99 },
              read_target: { choice: passage.id, confidence: 0.96 },
            },
          }),
          deciderOk('action', second),
          deciderOk('action', terminal('BLOCKED')),
        ],
      });
      const result = await createTaskAgent({ host: host.host, decider: fake.decider }).run(
        makeRequest({
          goal: 'Read the shipping policy.',
          options: { captureTrace: true, budgets: { maxModelCalls } },
        })
      );
      expect(fake.calls.chooseAction).toHaveLength(maxModelCalls === 1 ? 1 : 3);
      expect(result.stats.usage.modelCalls).toBe(maxModelCalls);
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(
        maxModelCalls === 1 ? [] : ['READ']
      );
      if (maxModelCalls > 1) {
        expect(fake.calls.chooseAction[1]?.request.offers.targets.READ).toEqual([passage.id]);
        expect(fake.calls.chooseAction[1]?.request.offers.operations).not.toContain('CLICK');
        expect(
          (result.trace ?? []).filter(
            event => event.type === 'decision' && event.operation === 'READ'
          )
        ).toEqual([expect.objectContaining({ confidence: 0.88 })]);
      }
    }
  );

  test('the second action cannot escape its reduced offered target pool', async () => {
    const firstPassage = makePassage({ id: 'first' });
    const secondPassage = makePassage({ id: 'second' });
    const host = makeFakeHost({
      observations: [makeObservation({ elements: [firstPassage, secondPassage, makeElement()] })],
    });
    const invalid: TaskActionDecision = {
      operation: 'CLICK',
      target: { kind: 'none_appropriate' },
      confidence: 0.99,
      operationConfidence: 0.99,
    };
    const fake = makeFakeDecider({
      chooseAction: [
        deciderOk('action', invalid, {
          answers: { read_target: { choice: firstPassage.id, confidence: 0.99 } },
        }),
        deciderOk('action', action('READ', secondPassage.id)),
      ],
    });
    const result = await createTaskAgent({ host: host.host, decider: fake.decider }).run(
      makeRequest({ options: { budgets: { maxInvalidDecisions: 1 } } })
    );
    expect(result.status).toBe('blocked');
    expect(host.calls.execute).toHaveLength(0);
    expect(fake.calls.chooseAction).toHaveLength(2);
    expect(fake.calls.chooseAction[1]?.request.offers.targets.READ).toEqual([firstPassage.id]);
  });

  test('a physical whitespace-named native group remains exclusive after name sanitization', async () => {
    const first = makeCheckbox({
      id: 'first',
      controlId: 'ctl_first',
      kind: 'radio',
      inputType: 'radio',
      inputName: '',
      groupId: 'f1: ',
      state: { checked: true },
    });
    const second = makeCheckbox({
      ...first,
      id: 'second',
      controlId: 'ctl_second',
      label: 'Second option',
      state: { ...first.state, checked: false },
    });
    const host = makeFakeHost({ observations: [makeObservation({ elements: [first, second] })] });
    const fake = makeFakeDecider({
      chooseArgument: [deciderOk('argument', { kind: 'keep_current', confidence: 0.99 })],
      chooseAction: [deciderOk('action', terminal('BLOCKED'))],
    });
    await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(makeRequest({ goal: 'Keep the current selection.' }));
    expect(fake.calls.chooseArgument).toHaveLength(1);
    expect(fake.calls.chooseArgument[0]?.request.purpose).toBe('group');
    expect(host.calls.execute).toHaveLength(0);
  });

  test.each([true, false])(
    'submitted-form empty validation is assessed without forcing intentional repair: %s',
    async repair => {
      const field = makeTextField({
        label: 'Required detail',
        formId: 'f1',
        formNoValidate: true,
        state: { value: '' },
      });
      const submit = makeSubmitButton({ formId: 'f1', formNoValidate: true });
      const before = makeObservation({
        elements: [field, submit],
        forms: [makeForm({ id: 'f1', fieldIds: [field.id], submitterIds: [submit.id] })],
      });
      const after = makeObservation({
        ...before,
        fingerprint: 'pf_error',
        elements: [{ ...field, state: { ...field.state, invalid: true } }, submit],
        validation: [{ source: 'aria', targetId: field.id, text: 'Enter the missing detail.' }],
      });
      const host = makeFakeHost({ observations: [before, after, after] });
      const fake = makeFakeDecider({
        chooseArgument: [
          deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 }),
          request => chooseCandidate(request, candidate => candidate.source === 'protocol'),
          deciderOk('argument', {
            kind: repair ? 'required_unavailable' : 'none_appropriate',
            confidence: 0.99,
          }),
        ],
        chooseAction: [
          deciderOk('action', action('SUBMIT', submit.id)),
          deciderOk('action', terminal('BLOCKED')),
        ],
        classifyCommitment: [
          deciderOk('commitment', {
            commitment: 'FORM_SUBMIT',
            confidence: 0.99,
            agreement: 'single',
          }),
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(
        makeRequest({
          goal: repair
            ? 'Submit valid details and continue.'
            : 'Test rejection of the missing detail.',
          authorization: { effects: ['form_submit'] },
        })
      );
      expect(result.status).toBe(repair ? 'needs_input' : 'blocked');
      expect(fake.calls.chooseArgument[2]?.request.purpose).toBe('validation');
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(['SUBMIT']);
    }
  );

  test('rejected completion withholds DONE until a real READ supplies new evidence', async () => {
    const passage = makePassage();
    const host = makeFakeHost({ observations: [makeObservation({ elements: [passage] })] });
    const fake = makeFakeDecider({
      chooseAction: [
        deciderOk('action', terminal('DONE')),
        deciderOk('action', action('READ', passage.id)),
        deciderOk('action', terminal('DONE')),
      ],
      verifyCompletion: [
        deciderOk(
          'completion',
          makeCompletionDecision({ verdict: 'UNCERTAIN', evidenceTargetIds: [] })
        ),
        deciderOk('completion', makeCompletionDecision({ evidenceTargetIds: [passage.id] })),
      ],
    });
    const result = await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(makeRequest({ goal: 'Read the shipping policy.' }));
    expect(result.status).toBe('completed');
    expect(fake.calls.chooseAction[0]?.request.offers.operations).toContain('DONE');
    expect(fake.calls.chooseAction[1]?.request.offers.operations).not.toContain('DONE');
    expect(fake.calls.chooseAction[2]?.request.offers.operations).toContain('DONE');
    expect(host.calls.execute.map(request => request.command.operation)).toEqual(['READ']);
    expect(fake.calls.verifyCompletion).toHaveLength(2);
  });

  test.each([true, false])(
    'peripheral assessment defers only for a known requested primary action: %s',
    async mainNeeded => {
      const main = makeSubmitButton({
        id: 'main',
        formId: 'f1',
        landmark: 'main',
        label: 'Continue primary workflow',
      });
      const email = makeTextField({
        id: 'footer_email',
        formId: 'f2',
        landmark: 'footer',
        label: 'Subscription email',
        state: { value: '' },
      });
      const signup = makeSubmitButton({
        id: 'signup',
        formId: 'f2',
        landmark: 'footer',
        label: 'Subscribe',
      });
      const before = makeObservation({
        elements: [email, signup, main],
        forms: [
          makeForm({ id: 'f1', fieldIds: [], submitterIds: [main.id] }),
          makeForm({ id: 'f2', fieldIds: [email.id], submitterIds: [signup.id] }),
        ],
      });
      const after = makeObservation({
        ...before,
        elements: [email, signup],
        forms: [makeForm({ id: 'f2', fieldIds: [email.id], submitterIds: [signup.id] })],
        fingerprint: 'pf_primary_advanced',
      });
      const host = makeFakeHost({ observations: mainNeeded ? [before, after, after] : [before] });
      const reply = (request: TaskChooseArgumentRequest) =>
        request.target?.id === email.id
          ? deciderOk('argument', { kind: 'required_unavailable' as const, confidence: 0.99 })
          : request.target?.id === main.id && !mainNeeded
            ? deciderOk('argument', { kind: 'none_appropriate' as const, confidence: 0.99 })
            : chooseCandidate(request, candidate => candidate.source === 'protocol');
      const fake = makeFakeDecider({
        chooseArgument: [reply, reply, reply],
        chooseAction: mainNeeded ? [deciderOk('action', action('SUBMIT', main.id))] : [],
        classifyCommitment: [
          deciderOk('commitment', {
            commitment: 'FORM_SUBMIT',
            confidence: 0.99,
            agreement: 'single',
          }),
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(
        makeRequest({
          goal: mainNeeded
            ? 'Continue the primary workflow, then subscribe.'
            : 'Subscribe using the footer form.',
          authorization: { effects: ['form_submit'] },
        })
      );
      expect(result.status).toBe('needs_input');
      expect(fake.calls.chooseArgument.map(call => call.request.target?.id)).toEqual([
        main.id,
        email.id,
        signup.id,
      ]);
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(
        mainNeeded ? ['SUBMIT'] : []
      );
      if (mainNeeded)
        expect(
          fake.calls.chooseAction[0]?.request.goalRequirements?.some(
            view => view.targetId === email.id
          )
        ).toBe(false);
    }
  );

  test.each([false, true])(
    'successful READ is withheld only for unchanged current document state: %s',
    async changed => {
      const first = makePassage({ id: 'first' });
      const second = makePassage({ id: 'second' });
      const before = makeObservation({ elements: [first, second] });
      const after = changed
        ? makeObservation({ ...before, fingerprint: 'pf_changed', documentId: 'doc_ffffffffffff' })
        : before;
      const host = makeFakeHost({ observations: [before, after, after] });
      const fake = makeFakeDecider({
        chooseAction: [
          deciderOk('action', action('READ', first.id)),
          deciderOk('action', action('READ', changed ? first.id : second.id)),
          deciderOk('action', terminal('BLOCKED')),
        ],
      });
      await createTaskAgent({ host: host.host, decider: fake.decider }).run(
        makeRequest({ goal: 'Read the available sections.' })
      );
      const offered = fake.calls.chooseAction[1]?.request.offers.targets.READ;
      if (changed) expect(offered).toContain(first.id);
      else expect(offered).not.toContain(first.id);
      expect(offered).toContain(second.id);
      expect(host.calls.execute).toHaveLength(2);
    }
  );

  test('dispatch records only exact nonsensitive preserved values from the submitted form', async () => {
    const stored = makeTextField({
      id: 'stored',
      formId: 'f1',
      label: 'Stored contact',
      state: { value: 'stored@example.test' },
    });
    const sensitive = makeTextField({
      ...stored,
      id: 'sensitive',
      label: 'Private stored data',
      sensitive: true,
      state: { ...stored.state, value: TASK_REDACTED },
    });
    const truncated = makeTextField({
      ...stored,
      id: 'truncated',
      label: 'Truncated data',
      state: { ...stored.state, value: 'prefix', valueTruncated: true },
    });
    const redacted = makeTextField({
      ...stored,
      id: 'redacted',
      label: 'Redacted data',
      state: { ...stored.state, value: TASK_REDACTED },
    });
    const foreign = makeTextField({
      ...stored,
      id: 'foreign',
      formId: 'f2',
      label: 'Other form data',
    });
    const submit = makeSubmitButton({ formId: 'f1' });
    const before = makeObservation({
      elements: [stored, sensitive, truncated, redacted, foreign, submit],
      forms: [
        makeForm({
          id: 'f1',
          fieldIds: [stored.id, sensitive.id, truncated.id, redacted.id],
          submitterIds: [submit.id],
        }),
      ],
    });
    const after = makeObservation({
      ...before,
      elements: [makePassage()],
      forms: [],
      fingerprint: 'pf_submitted',
    });
    const host = makeFakeHost({ observations: [before, after, after] });
    const reply = (request: TaskChooseArgumentRequest) =>
      request.operation === 'SUBMIT'
        ? chooseCandidate(request, candidate => candidate.source === 'protocol')
        : deciderOk('argument', { kind: 'keep_current' as const, confidence: 0.99 });
    const fake = makeFakeDecider({
      chooseArgument: [reply, reply, reply, reply, reply, reply],
      chooseAction: [
        deciderOk('action', action('SUBMIT', submit.id)),
        deciderOk('action', terminal('BLOCKED')),
      ],
      classifyCommitment: [
        deciderOk('commitment', {
          commitment: 'FORM_SUBMIT',
          confidence: 0.99,
          agreement: 'single',
        }),
      ],
    });
    const result = await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(
      makeRequest({
        goal: 'Use the stored information and submit.',
        inputs: { secret: 'retained-private-value' },
        inputDeclarations: [{ path: 'secret', sensitive: true }],
        authorization: { effects: ['form_submit'] },
      })
    );
    expect(result.status).toBe('blocked');
    expect(fake.calls.chooseAction[1]?.request.submittedControls).toEqual([
      {
        ledgerSeq: 1,
        origin: before.origin,
        label: stored.label,
        kind: stored.kind,
        effect: 'applied',
        preservedValue: stored.state.value,
      },
    ]);
    expect(host.calls.execute.map(request => request.command.operation)).toEqual(['SUBMIT']);
    expect(result.ledger.some(entry => entry.command.command.operation === 'FILL')).toBe(false);
  });

  test.each([false, true])(
    'exact empty public fields become counterevidence retained in completion or checkpoint: %s',
    async checkpoint => {
      const empty = makeTextField({ id: 'empty', label: 'Unfilled optional detail', formId: 'f1' });
      const exclusions = [
        makeTextField({ ...empty, id: 'sensitive', label: 'Private field', sensitive: true }),
        makeTextField({
          ...empty,
          id: 'disabled',
          label: 'Disabled field',
          state: { value: '', disabled: true },
        }),
        makeTextField({
          ...empty,
          id: 'truncated',
          label: 'Truncated field',
          state: { value: '', valueTruncated: true },
        }),
        makeTextField({
          ...empty,
          id: 'whitespace',
          label: 'Whitespace field',
          state: { value: ' ' },
        }),
        makeTextField({
          ...empty,
          id: 'nonempty',
          label: 'Populated field',
          state: { value: 'already present' },
        }),
        makeTextField({ ...empty, id: 'foreign', label: 'Foreign form', formId: 'f2' }),
        makeTextField({
          ...empty,
          id: 'unsupported',
          label: 'No FILL control',
          operations: ['READ'],
        }),
      ];
      const submit = makeSubmitButton({ formId: 'f1' });
      const before = makeObservation({ elements: [empty, ...exclusions, submit] });
      const after = makeObservation({
        ...before,
        elements: checkpoint
          ? [makeTextField({ id: 'missing', label: 'Next required detail' })]
          : [makePassage()],
        fingerprint: 'pf_receipt',
      });
      const host = makeFakeHost({ observations: [before, after, after] });
      const argumentReply = (request: TaskChooseArgumentRequest) =>
        request.target?.id === 'missing'
          ? deciderOk('argument', { kind: 'required_unavailable' as const, confidence: 0.99 })
          : request.operation === 'SUBMIT'
            ? chooseCandidate(request, candidate => candidate.source === 'protocol')
            : deciderOk('argument', { kind: 'none_appropriate' as const, confidence: 0.99 });
      const fake = makeFakeDecider({
        chooseArgument: Array.from({ length: 9 }, () => argumentReply),
        chooseAction: [
          deciderOk('action', action('SUBMIT', submit.id)),
          deciderOk('action', terminal('DONE')),
          deciderOk('action', terminal('BLOCKED')),
        ],
        classifyCommitment: [
          deciderOk('commitment', {
            commitment: 'FORM_SUBMIT',
            confidence: 0.99,
            agreement: 'single',
          }),
        ],
        verifyCompletion: [
          deciderOk('completion', makeCompletionDecision({ verdict: 'UNCERTAIN' })),
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(
        makeRequest({
          goal: 'Submit the current form.',
          authorization: { effects: ['form_submit'] },
        })
      );
      const facts = [
        {
          ledgerSeq: 1,
          origin: before.origin,
          label: empty.label,
          kind: empty.kind,
          effect: 'applied',
          observedEmptyAtSubmission: true,
        },
      ];
      if (checkpoint) {
        expect(result.status).toBe('needs_input');
        if (result.status !== 'needs_input') throw new Error('Expected signed checkpoint.');
        expect(result.checkpoint.submittedControls).toEqual(facts);
        expect(result.checkpoint.integrity).toMatch(/^sha256:/);
      } else {
        expect(fake.calls.chooseAction[1]?.request.submittedControls).toEqual(facts);
        expect(fake.calls.verifyCompletion[0]?.request.submittedControls).toEqual(facts);
        expect(result.status).toBe('blocked');
      }
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(['SUBMIT']);
    }
  );

  test('cached footer requirements are rejudged only after a later actual primary form dispatch', async () => {
    const email = makeTextField({
      id: 'footer_email',
      label: 'Subscription email',
      formId: 'f2',
      landmark: 'footer',
      state: { value: 'member@example.test' },
    });
    const link = makeLink({ id: 'next', label: 'Continue', landmark: 'main' });
    const consent = makeCheckbox({
      id: 'consent',
      label: 'Marketing consent',
      formId: 'f1',
      landmark: 'main',
      state: { checked: true },
    });
    const submit = makeSubmitButton({ id: 'primary', formId: 'f1', landmark: 'main' });
    const before = makeObservation({ elements: [email, link] });
    const middle = makeObservation({
      ...before,
      elements: [email, consent, submit],
      forms: [makeForm({ id: 'f1', fieldIds: [consent.id], submitterIds: [submit.id] })],
      fingerprint: 'pf_primary',
    });
    const after = makeObservation({
      ...before,
      elements: [email, makePassage({ label: 'Resulting record' })],
      fingerprint: 'pf_record',
    });
    const host = makeFakeHost({ observations: [before, before, middle, after, after] });
    const reply = (request: TaskChooseArgumentRequest) =>
      request.target?.id === email.id
        ? request.submittedControls?.some(
            control => control.label === consent.label && control.checked === true
          )
          ? deciderOk('argument', { kind: 'none_appropriate' as const, confidence: 0.99 })
          : chooseCandidate(request, candidate => candidate.source === 'input')
        : request.target?.id === consent.id
          ? deciderOk('argument', { kind: 'keep_current' as const, confidence: 0.99 })
          : chooseCandidate(request, candidate => candidate.source === 'protocol');
    const fake = makeFakeDecider({
      chooseArgument: [reply, reply, reply, reply],
      verifyCompletion: [
        deciderOk('completion', makeCompletionDecision({ verdict: 'NOT_SATISFIED' })),
      ],
      chooseAction: [
        deciderOk('action', action('NAVIGATE', link.id)),
        deciderOk('action', action('SUBMIT', submit.id)),
        deciderOk('action', terminal('BLOCKED')),
      ],
      classifyCommitment: [
        deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        deciderOk('commitment', {
          commitment: 'FORM_SUBMIT',
          confidence: 0.99,
          agreement: 'single',
        }),
      ],
    });
    await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(
      makeRequest({
        goal: 'Complete the primary workflow and opt in.',
        inputs: { email: 'member@example.test' },
        authorization: { effects: ['form_submit'] },
      })
    );
    const footerCalls = fake.calls.chooseArgument.filter(
      call => call.request.target?.id === email.id
    );
    expect(footerCalls).toHaveLength(2);
    expect(footerCalls[0]?.request.submittedControls).toEqual([]);
    expect(footerCalls[1]?.request.submittedControls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: consent.label, checked: true, ledgerSeq: 2 }),
      ])
    );
    expect(host.calls.execute.map(request => request.command.operation)).toEqual([
      'NAVIGATE',
      'SUBMIT',
    ]);
    expect(
      fake.calls.chooseAction[2]?.request.goalRequirements?.some(view => view.targetId === email.id)
    ).toBe(false);
  });

  test.each([0, 1])(
    'a failed completion call rearms only within existing decider failure budget: %s',
    async maxDeciderFailures => {
      const buy = makeElement({
        label: 'Place order',
        commitHints: [{ class: 'PURCHASE', basis: 'declared_marker' }],
      });
      const receipt = makePassage({ label: 'Order receipt', text: 'Order R42 was created.' });
      const before = makeObservation({ elements: [buy] });
      const after = makeObservation({
        ...before,
        url: before.url + '/receipt',
        documentId: 'doc_ffffffffffff',
        fingerprint: 'pf_receipt',
        elements: [receipt],
      });
      const host = makeFakeHost({ observations: [before, after, after, after] });
      const fake = makeFakeDecider({
        chooseAction: [deciderOk('action', action('CLICK', buy.id))],
        classifyCommitment: [
          deciderOk('commitment', {
            commitment: 'PURCHASE',
            confidence: 0.99,
            agreement: 'single',
          }),
        ],
        verifyCompletion: [
          deciderFail('INVALID_RESPONSE', {
            message: 'Malformed completion answer.',
            retryable: false,
          }),
          deciderOk('completion', makeCompletionDecision({ evidenceTargetIds: [receipt.id] })),
        ],
      });
      const result = await createTaskAgent({ host: host.host, decider: fake.decider }).run(
        makeRequest({
          goal: 'Place the order.',
          authorization: { effects: ['purchase'] },
          options: { budgets: { maxDeciderFailures } },
        })
      );
      expect(result.status).toBe(maxDeciderFailures === 0 ? 'failed' : 'completed');
      expect(fake.calls.verifyCompletion).toHaveLength(maxDeciderFailures === 0 ? 1 : 2);
      expect(fake.calls.chooseAction).toHaveLength(1);
      expect(host.calls.execute).toHaveLength(1);
      expect(result.stats.usage.modelCalls).toBe(maxDeciderFailures === 0 ? 3 : 4);
    }
  );

  test('a changed public parent SELECT resamples only unavailable public SELECT siblings in its form', async () => {
    const option = {
      id: 'option.ca',
      label: 'Canada',
      value: 'CA',
      selected: false,
      disabled: false,
    };
    const country = makeSelectField({
      id: 'country',
      formId: 'f1',
      label: 'Country',
      options: [option],
      state: { value: '' },
    });
    const province = makeSelectField({
      id: 'province',
      formId: 'f1',
      label: 'Province',
      options: [{ ...option, id: 'province.on', label: 'Ontario', value: 'ON' }],
      state: { value: '' },
    });
    const email = makeTextField({
      id: 'email',
      formId: 'f1',
      label: 'Missing email',
      state: { value: '' },
    });
    const foreign = makeSelectField({
      ...province,
      id: 'foreign',
      formId: 'f2',
      label: 'Other form selection',
    });
    const sensitive = makeSelectField({
      ...province,
      id: 'sensitive',
      sensitive: true,
      label: 'Private selection',
    });
    const before = makeObservation({ elements: [country, province, email, foreign, sensitive] });
    const afterCountry = makeObservation({
      ...before,
      fingerprint: 'pf_country_context',
      elements: [
        {
          ...country,
          state: { ...country.state, value: 'CA' },
          options: country.options?.map(value => ({ ...value, selected: true })),
        },
        province,
        email,
        foreign,
        sensitive,
      ],
    });
    const afterProvince = makeObservation({
      ...afterCountry,
      fingerprint: 'pf_province_context',
      elements: afterCountry.elements.map(element =>
        element.id === province.id
          ? {
              ...province,
              state: { ...province.state, value: 'ON' },
              options: province.options?.map(value => ({ ...value, selected: true })),
            }
          : element
      ),
    });
    const host = makeFakeHost({
      observations: [before, afterCountry, afterProvince, afterProvince],
      outcomes: [
        makeOutcome('applied', 'applied', {
          readback: { kind: 'select', control: 'native', index: 0, changed: true, matched: true },
        }),
      ],
    });
    const unavailable = deciderOk('argument', {
      kind: 'required_unavailable' as const,
      confidence: 0.99,
    });
    const fake = makeFakeDecider({
      chooseArgument: [
        request => chooseCandidate(request, candidate => candidate.label === 'Canada'),
        unavailable,
        unavailable,
        unavailable,
        unavailable,
        request => chooseCandidate(request, candidate => candidate.label === 'Ontario'),
      ],
      classifyCommitment: [
        deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
      ],
    });
    const result = await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(makeRequest({ goal: 'Use the required information in Canada.' }));
    expect(result.status).toBe('needs_input');
    expect(
      fake.calls.chooseArgument.filter(call => call.request.target?.id === province.id)
    ).toHaveLength(2);
    for (const field of [email, foreign, sensitive])
      expect(
        fake.calls.chooseArgument.filter(call => call.request.target?.id === field.id)
      ).toHaveLength(1);
    expect(host.calls.execute.map(request => request.command.operation)).toEqual([
      'SELECT',
      'SELECT',
    ]);
  });

  test.each([true, false])(
    'only a verified exclusive native radio parent resamples unavailable selects: %s',
    async exclusive => {
      const parent = makeCheckbox({
        id: 'country',
        label: 'Canada',
        kind: exclusive ? 'radio' : 'checkbox',
        inputType: exclusive ? 'radio' : 'checkbox',
        inputName: 'country',
        ...(exclusive ? { groupId: 'f1:country', controlId: 'ctl_country' } : {}),
        formId: 'f1',
        state: { value: 'CA', checked: false },
      });
      const child = makeSelectField({
        id: 'province',
        label: 'Province',
        formId: 'f1',
        options: [
          { id: 'province.on', label: 'Ontario', value: 'ON', selected: false, disabled: false },
        ],
        state: { value: '' },
      });
      const email = makeTextField({
        id: 'email',
        label: 'Missing email',
        formId: 'f1',
        state: { value: '' },
      });
      const before = makeObservation({ elements: [parent, child, email] });
      const changed = makeObservation({
        ...before,
        elements: [{ ...parent, state: { ...parent.state, checked: true } }, child, email],
        fingerprint: 'pf_country_checked',
      });
      const chosen = makeObservation({
        ...changed,
        elements: [
          { ...parent, state: { ...parent.state, checked: true } },
          {
            ...child,
            state: { ...child.state, value: 'ON' },
            options: child.options?.map(option => ({ ...option, selected: true })),
          },
          email,
        ],
        fingerprint: 'pf_province_chosen',
      });
      const host = makeFakeHost({
        observations: [before, changed, chosen, chosen],
        outcomes: [
          makeOutcome('applied', 'applied', {
            readback: {
              kind: 'setChecked',
              control: 'native',
              before: false,
              after: true,
              changed: true,
              matched: true,
            },
          }),
        ],
      });
      let provinceJudgments = 0;
      const argumentReply = (request: TaskChooseArgumentRequest) =>
        request.target?.id === parent.id
          ? chooseCandidate(request, candidate =>
              exclusive ? candidate.id === parent.id : candidate.source === 'protocol'
            )
          : request.target?.id === child.id && ++provinceJudgments > 1
            ? chooseCandidate(request, candidate => candidate.label === 'Ontario')
            : deciderOk('argument', { kind: 'required_unavailable' as const, confidence: 0.99 });
      const fake = makeFakeDecider({
        chooseArgument: [argumentReply, argumentReply, argumentReply, argumentReply],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(makeRequest({ goal: 'Use the required information in Canada.' }));
      expect(result.status).toBe('needs_input');
      expect(
        fake.calls.chooseArgument.filter(call => call.request.target?.id === child.id)
      ).toHaveLength(exclusive ? 2 : 1);
      expect(
        fake.calls.chooseArgument.filter(call => call.request.target?.id === email.id)
      ).toHaveLength(1);
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(
        exclusive ? ['SET_CHECKED', 'SELECT'] : ['SET_CHECKED']
      );
    }
  );

  test('KEEP_CURRENT checked state and bounded observed selection labels remain dispatch facts', async () => {
    const checkbox = makeCheckbox({
      id: 'consent',
      formId: 'f1',
      label: 'Existing consent',
      state: { checked: true },
    });
    const options = Array.from({ length: 25 }, (_, index) => ({
      id: `speed.${index}`,
      label: `Observed choice ${index}`,
      value: String(index),
      selected: index === 1,
      disabled: index === 0,
    }));
    const select = makeSelectField({
      id: 'speed',
      formId: 'f1',
      label: 'Delivery speed',
      options,
      state: { value: '1' },
    });
    const submit = makeSubmitButton({ formId: 'f1' });
    const before = makeObservation({
      elements: [checkbox, select, submit],
      forms: [
        makeForm({ id: 'f1', fieldIds: [checkbox.id, select.id], submitterIds: [submit.id] }),
      ],
    });
    const after = makeObservation({
      ...before,
      elements: [makePassage()],
      forms: [],
      fingerprint: 'pf_dispatched',
    });
    const host = makeFakeHost({ observations: [before, after, after] });
    const fake = makeFakeDecider({
      chooseArgument: [
        deciderOk('argument', { kind: 'keep_current', confidence: 0.99 }),
        deciderOk('argument', { kind: 'keep_current', confidence: 0.99 }),
        request => chooseCandidate(request, candidate => candidate.source === 'protocol'),
      ],
      chooseAction: [
        deciderOk('action', action('SUBMIT', submit.id)),
        deciderOk('action', terminal('BLOCKED')),
      ],
      classifyCommitment: [
        deciderOk('commitment', {
          commitment: 'FORM_SUBMIT',
          confidence: 0.99,
          agreement: 'single',
        }),
      ],
    });
    await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(
      makeRequest({
        goal: 'Use existing details and continue.',
        authorization: { effects: ['form_submit'] },
      })
    );
    const facts = fake.calls.chooseAction[1]?.request.submittedControls;
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: checkbox.label, checked: true, preservedChecked: true }),
        expect.objectContaining({
          label: select.label,
          selectedOption: {
            label: options[1]?.label,
            observedLabels: options
              .filter(option => !option.disabled)
              .slice(0, 20)
              .map(option => option.label),
            labelsTruncated: true,
          },
        }),
      ])
    );
    expect(host.calls.execute.map(request => request.command.operation)).toEqual(['SUBMIT']);
  });

  test('exhausted protocol arguments return actual known missing input without inventing data', async () => {
    const field = makeTextField({
      label: 'Required detail',
      region: 'Workflow',
      state: { value: '' },
    });
    const link = makeLink({ id: 'next', region: field.region });
    const host = makeFakeHost({ observations: [makeObservation({ elements: [field, link] })] });
    const wait: TaskActionDecision = {
      operation: 'WAIT',
      target: { kind: 'not_applicable' },
      confidence: 0.99,
      operationConfidence: 0.99,
    };
    const fake = makeFakeDecider({
      chooseArgument: [
        deciderOk('argument', { kind: 'required_unavailable', confidence: 0.99 }),
        deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 }),
      ],
      chooseAction: [deciderOk('action', wait)],
    });
    const result = await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(
      makeRequest({
        goal: 'Use the missing required detail.',
        options: { budgets: { maxInvalidDecisions: 0 } },
      })
    );
    expect(result.status).toBe('needs_input');
    expect(host.calls.execute).toHaveLength(0);
    expect(fake.calls.chooseArgument[1]?.request.slot).toBe('duration');
    expect(result.stats.usage.invalidDecisions).toBe(1);
  });

  test.each([true, false])(
    'unrelated toggle is rejudged only after successful navigation to a changed URL: %s',
    async changedUrl => {
      const toggle = makeCheckbox({ label: 'Saved item', state: { checked: false } });
      const link = makeLink({ id: 'results', href: 'https://shop.example.test/cart?q=item' });
      const before = makeObservation({ elements: [toggle, link] });
      const after = makeObservation({
        ...before,
        url: changedUrl ? `${before.url}?q=item` : before.url,
        fingerprint: 'pf_filtered',
      });
      const host = makeFakeHost({
        observations: [before, after, after],
        outcomes: [makeOutcome('navigated', 'applied')],
      });
      const unrelated = () =>
        deciderOk('argument', { kind: 'none_appropriate' as const, confidence: 0.99 });
      const fake = makeFakeDecider({
        chooseArgument: [unrelated, unrelated, unrelated],
        chooseAction: [
          deciderOk('action', action('NAVIGATE', link.id)),
          deciderOk('action', terminal('BLOCKED')),
        ],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
      });
      await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(makeRequest({ goal: 'Find the matching item in saved results.' }));
      expect(fake.calls.chooseArgument).toHaveLength(changedUrl ? 2 : 1);
      expect(fake.calls.chooseAction[1]?.request.goalRequirements).toEqual([]);
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(['NAVIGATE']);
    }
  );

  test.each([
    'matching',
    'changed',
    'foreign',
    'sensitive',
    'truncated',
    'ambiguous',
    'no_navigation',
  ] as const)(
    'only a matching confirmed public GET form carries actual activation across a title change: %s',
    async variant => {
      const endpoint = 'https://shop.example.test/search';
      const query = makeTextField({
        id: 'query',
        label: 'Search terms',
        inputName: 'q',
        inputType: 'search',
        formId: 'f1',
        sensitive: variant === 'sensitive',
        state: { value: 'steel', valueTruncated: variant === 'truncated' },
        twins: variant === 'ambiguous' ? 2 : 1,
      });
      const submit = makeSubmitButton({
        label: 'Search',
        formId: 'f1',
        formTarget: { action: endpoint, method: 'GET' },
      });
      const form = makeForm({
        id: 'f1',
        action: endpoint,
        method: 'GET',
        fieldIds: [query.id],
        submitterIds: [submit.id],
      });
      const before = makeObservation({
        title: 'Catalog',
        elements: [query, submit],
        forms: [form],
      });
      const after = makeObservation({
        ...before,
        title: 'Results',
        documentId: 'doc_results',
        url: endpoint + '?q=steel',
        fingerprint: 'pf_results',
        elements: [
          variant === 'changed' ? { ...query, state: { ...query.state, value: 'copper' } } : query,
          variant === 'foreign'
            ? { ...submit, formTarget: { action: endpoint + '/another', method: 'GET' } }
            : submit,
        ],
      });
      const host = makeFakeHost({
        observations: [before, after, after],
        outcomes: [
          variant === 'no_navigation'
            ? makeOutcome('applied', 'applied')
            : makeOutcome('navigated', 'uncertain', {
                navigation: {
                  kind: 'document',
                  fromDocumentId: before.documentId,
                  toDocumentId: after.documentId,
                  fromUrl: before.url,
                  toUrl: after.url,
                  realmLost: true,
                },
              }),
        ],
      });
      let submitCalls = 0;
      const reply = (request: TaskChooseArgumentRequest) =>
        request.operation === 'SUBMIT'
          ? ++submitCalls === 1
            ? chooseCandidate(request, candidate => candidate.source === 'protocol')
            : deciderOk('argument', { kind: 'uncertain_requirement' as const, confidence: 0.99 })
          : deciderOk('argument', { kind: 'keep_current' as const, confidence: 0.99 });
      const fake = makeFakeDecider({
        chooseArgument: [reply, reply, reply, reply],
        chooseAction: [
          deciderOk('action', action('SUBMIT', submit.id)),
          deciderOk('action', terminal('BLOCKED')),
        ],
        classifyCommitment: [
          deciderOk('commitment', {
            commitment: 'FORM_SUBMIT',
            confidence: 0.99,
            agreement: 'single',
          }),
        ],
        verifyCompletion: [
          deciderOk('completion', makeCompletionDecision({ evidenceTargetIds: [query.id] })),
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(
        makeRequest({
          goal: 'Show the requested search results.',
          authorization: { effects: ['form_submit'] },
          options: { budgets: { maxInvalidDecisions: 0 } },
        })
      );
      expect(submitCalls).toBe(variant === 'matching' ? 1 : 2);
      expect(result.status).toBe(variant === 'matching' ? 'completed' : 'blocked');
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(['SUBMIT']);
      expect(fake.calls.verifyCompletion).toHaveLength(variant === 'matching' ? 1 : 0);
      if (variant === 'matching') {
        expect(fake.calls.verifyCompletion[0]?.request.goalRequirements).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ targetId: submit.id, operation: 'SUBMIT', satisfied: true }),
          ])
        );
      }
    }
  );

  test.each(['missing_digest', 'null_digest', 'invalid_digest'] as const)(
    'a genuine re-signed checkpoint cannot carry a malformed activation witness into a private form: %s',
    async variant => {
      const checkpointKey = 'test-activation-witness-checkpoint-key';
      const endpoint = 'https://shop.example.test/search';
      const query = makeTextField({
        id: 'query',
        inputName: 'q',
        formId: 'f1',
        state: { value: 'steel' },
      });
      const submit = makeSubmitButton({
        label: 'Search',
        formId: 'f1',
        formTarget: { action: endpoint, method: 'GET' },
      });
      const form = makeForm({
        id: 'f1',
        method: 'GET',
        action: endpoint,
        fieldIds: [query.id],
        submitterIds: [submit.id],
      });
      const before = makeObservation({
        title: 'Catalog',
        elements: [query, submit],
        forms: [form],
      });
      const missing = makeTextField({ id: 'missing', formId: 'f2', label: 'Next required detail' });
      const after = makeObservation({
        ...before,
        title: 'Results',
        documentId: 'doc_results',
        url: endpoint + '?q=steel',
        elements: [query, submit, missing],
      });
      const host = makeFakeHost({
        observations: [before, after, after],
        outcomes: [
          makeOutcome('navigated', 'uncertain', {
            navigation: {
              kind: 'document',
              fromDocumentId: before.documentId,
              toDocumentId: after.documentId,
              fromUrl: before.url,
              toUrl: after.url,
              realmLost: true,
            },
          }),
        ],
      });
      const reply = (request: TaskChooseArgumentRequest) =>
        request.target?.id === missing.id
          ? deciderOk('argument', { kind: 'required_unavailable' as const, confidence: 0.99 })
          : request.operation === 'SUBMIT'
            ? chooseCandidate(request, candidate => candidate.source === 'protocol')
            : deciderOk('argument', { kind: 'keep_current' as const, confidence: 0.99 });
      const fake = makeFakeDecider({
        chooseArgument: [reply, reply, reply, reply],
        chooseAction: [deciderOk('action', action('SUBMIT', submit.id))],
        classifyCommitment: [
          deciderOk('commitment', {
            commitment: 'FORM_SUBMIT',
            confidence: 0.99,
            agreement: 'single',
          }),
        ],
      });
      const paused = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
        options: { checkpointKey },
      }).run(makeRequest({ authorization: { effects: ['form_submit'] } }));
      expect(paused.status).toBe('needs_input');
      if (paused.status !== 'needs_input')
        throw new Error('Expected genuine signed activation checkpoint.');
      const edited = JSON.parse(JSON.stringify(paused.checkpoint)) as TaskCheckpoint;
      const witnessed = edited.goalRequirements?.filter(
        requirement => requirement.activationWitness
      );
      expect(witnessed?.length).toBeGreaterThan(0);
      for (const requirement of witnessed ?? []) {
        const witness = requirement.activationWitness as unknown as Record<string, unknown>;
        if (variant === 'missing_digest') delete witness.publicControlsDigest;
        else
          witness.publicControlsDigest = variant === 'null_digest' ? null : 'not-a-sha256-digest';
      }
      const { integrity, ...unsigned } = edited;
      const resigned = {
        ...unsigned,
        integrity: `hmac_sha256:${hmacSha256Hex(checkpointKey, stableStringify(unsigned))}`,
      };
      expect(resigned.integrity).not.toBe(integrity);
      const resumedHost = makeFakeHost({
        observations: [{ ...after, elements: [{ ...query, sensitive: true }, submit, missing] }],
      });
      const resumedFake = makeFakeDecider({
        chooseAction: [deciderOk('action', terminal('DONE'))],
      });
      const result = await createTaskAgent({
        host: resumedHost.host,
        decider: { ...resumedFake.decider, supportsRequirements: true },
        options: { checkpointKey },
      }).resume({
        checkpoint: resigned,
        resolution: { kind: 'inputs', inputs: { detail: 'Provided' } },
      });
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') throw new Error('Expected malformed witness rejection.');
      expect(result.error.code).toBe('CHECKPOINT_INVALID');
      expect(resumedHost.calls.observe).toHaveLength(0);
      expect(resumedHost.calls.execute).toHaveLength(0);
      expect(resumedFake.calls.verifyCompletion).toHaveLength(0);
    }
  );

  test.each([
    ['SATISFIED', 4],
    ['UNCERTAIN', 4],
    ['UNCERTAIN', 0],
  ] as const)(
    'exhausted protocol selection after real progress requires a fresh full verdict: %s, rejection budget %s',
    async (verdict, maxPrematureDone) => {
      const field = makeTextField({ state: { value: '' } });
      const passage = makePassage();
      const before = makeObservation({ elements: [field, passage] });
      const after = makeObservation({ ...before, documentId: 'doc_receipt', elements: [passage] });
      const host = makeFakeHost({
        observations: [before, after, after, after],
      });
      const fake = makeFakeDecider({
        chooseArgument: [
          request => chooseCandidate(request, candidate => candidate.source === 'input'),
          deciderOk('argument', { kind: 'none_appropriate', confidence: 0.99 }),
        ],
        chooseAction: [
          deciderOk('action', action('READ', passage.id)),
          deciderOk('action', {
            operation: 'WAIT',
            target: { kind: 'not_applicable' },
            confidence: 0.99,
            operationConfidence: 0.99,
          }),
        ],
        verifyCompletion: [
          deciderOk(
            'completion',
            makeCompletionDecision({ verdict, evidenceTargetIds: [passage.id] })
          ),
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(
        makeRequest({
          goal: 'Use the provided detail and read the policy.',
          inputs: { detail: 'provided' },
          options: { budgets: { maxInvalidDecisions: 0, maxPrematureDone } },
        })
      );
      expect(result.status).toBe(verdict === 'SATISFIED' ? 'completed' : 'blocked');
      expect(fake.calls.verifyCompletion).toHaveLength(1);
      expect(host.calls.execute.map(request => request.command.operation)).toEqual([
        'FILL',
        'READ',
      ]);
      expect(result.stats.usage.invalidDecisions).toBe(1);
      expect(result.stats.usage.modelCalls).toBe(5);
      expect(result.stats.usage.prematureDone).toBe(verdict === 'SATISFIED' ? 0 : 1);
      if (result.status === 'blocked') {
        expect(result.reason).toBe(
          maxPrematureDone === 0 ? 'COMPLETION_NOT_VERIFIED' : 'MODEL_UNCERTAIN'
        );
      }
    }
  );

  test('initial satisfied controls still require whole-goal verification before completion', async () => {
    const preference = makeCheckbox({ state: { checked: false } });
    const host = makeFakeHost({ observations: [makeObservation({ elements: [preference] })] });
    const fake = makeFakeDecider({
      chooseArgument: [
        request => chooseCandidate(request, candidate => candidate.label === 'Set unchecked'),
      ],
      chooseAction: [deciderOk('action', { ...terminal('DONE'), confidence: 0.01 })],
      verifyCompletion: [
        deciderOk('completion', makeCompletionDecision({ verdict: 'NOT_SATISFIED' })),
      ],
    });
    const result = await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(makeRequest({ options: { budgets: { maxInvalidDecisions: 0 } } }));
    expect(result.status).toBe('blocked');
    expect(fake.calls.verifyCompletion).toHaveLength(1);
    expect(result.stats.usage.prematureDone).toBe(1);
    expect(host.calls.execute).toHaveLength(0);
  });

  test('a rejected no-op probe permits the independently required follow-up action before a real verified completion', async () => {
    const preference = makeCheckbox({ state: { checked: false } });
    const link = makeLink();
    const passage = makePassage({ label: 'Help content' });
    const before = makeObservation({ elements: [preference, link] });
    const after = makeObservation({
      ...before,
      url: link.href,
      documentId: 'doc_help',
      elements: [preference, passage],
      fingerprint: 'pf_help',
    });
    const host = makeFakeHost({ observations: [before, before, after, after] });
    const fake = makeFakeDecider({
      chooseArgument: [
        request => chooseCandidate(request, candidate => candidate.label === 'Set unchecked'),
      ],
      chooseAction: [deciderOk('action', action('NAVIGATE', link.id))],
      classifyCommitment: [
        deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
      ],
      verifyCompletion: [
        deciderOk('completion', makeCompletionDecision({ verdict: 'NOT_SATISFIED' })),
        deciderOk('completion', makeCompletionDecision({ evidenceTargetIds: [passage.id] })),
      ],
    });
    const result = await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(
      makeRequest({
        goal: 'Keep the preference off and open the help page.',
        options: { captureTrace: true },
      })
    );
    expect(result.status).toBe('completed');
    expect(fake.calls.verifyCompletion).toHaveLength(2);
    expect(fake.calls.chooseAction).toHaveLength(1);
    expect(host.calls.execute.map(request => request.command.operation)).toEqual(['NAVIGATE']);
    expect(result.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'done_gate',
          passed: false,
          failures: expect.arrayContaining(['VERIFIER_NOT_SATISFIED']),
        }),
      ])
    );
  });

  test.each([
    'sat',
    'missing',
    'duplicate',
    'orphan',
    'stale_snapshot',
    'stale_session',
    'wrong_signature',
    'not_satisfied',
    'uncertain',
    'low',
    'nonfinite',
    'whole_not_satisfied',
  ] as const)(
    'unresolved controls require real complete current-bound SAT proofs without authorizing mutation: %s',
    async variant => {
      const preference = makeCheckbox({ state: { checked: false } });
      const unknown = makeSubmitButton({
        id: 'lookup',
        label: 'Order lookup',
        formId: 'f2',
        landmark: 'header',
      });
      const next = makeLink({ landmark: 'main' });
      const host = makeFakeHost({
        observations: [makeObservation({ elements: [preference, unknown, next] })],
      });
      const fake = makeFakeDecider({
        chooseArgument: [
          request => chooseCandidate(request, candidate => candidate.label === 'Set unchecked'),
          deciderOk('argument', { kind: 'uncertain_requirement', confidence: 0.99 }),
        ],
        chooseAction: [deciderOk('action', terminal('BLOCKED'))],
        verifyCompletion: [
          request => {
            const target = request.unresolvedControls?.[0];
            if (!target) throw new Error('Expected explicit current unresolved counterevidence.');
            const receipt = {
              target: { ...target },
              verdict: (variant === 'not_satisfied'
                ? 'NOT_SATISFIED'
                : variant === 'uncertain'
                  ? 'UNCERTAIN'
                  : 'SATISFIED') as TaskCompletionDecision['verdict'],
              confidence: variant === 'low' ? 0.1 : variant === 'nonfinite' ? Number.NaN : 0.99,
            };
            if (variant === 'orphan') receipt.target.targetId = preference.id;
            if (variant === 'stale_snapshot') receipt.target.snapshotId += '_old';
            if (variant === 'stale_session') receipt.target.sessionId += '_old';
            if (variant === 'wrong_signature') receipt.target.signature += '_wrong';
            return deciderOk(
              'completion',
              makeCompletionDecision({
                verdict: variant === 'whole_not_satisfied' ? 'NOT_SATISFIED' : 'SATISFIED',
                evidenceTargetIds: [preference.id],
                ...(variant === 'missing'
                  ? {}
                  : {
                      unresolvedControlStates:
                        variant === 'duplicate' ? [receipt, receipt] : [receipt],
                    }),
              })
            );
          },
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(makeRequest({ goal: 'Keep promotional emails off.' }));
      expect(result.status).toBe(variant === 'sat' ? 'completed' : 'blocked');
      expect(fake.calls.verifyCompletion).toHaveLength(1);
      expect(fake.calls.verifyCompletion[0]?.request.unresolvedControls).toEqual([
        expect.objectContaining({ targetId: unknown.id, signature: unknown.signature }),
      ]);
      expect(host.calls.execute).toHaveLength(0);
      if (variant !== 'sat') {
        expect(fake.calls.chooseAction[0]?.request.offers.operations).not.toContain('DONE');
        expect(fake.calls.chooseAction[0]?.request.offers.targets.SUBMIT).toEqual([]);
      }
    }
  );

  test('completion refuses to probe when every current unresolved control cannot be represented', async () => {
    const preference = makeCheckbox({ state: { checked: false } });
    const unknown = Array.from({ length: 21 }, (_, index) =>
      makeSubmitButton({
        id: `unknown${index}`,
        label: `Unresolved control ${index}`,
        formId: `other${index}`,
      })
    );
    const next = makeLink({ landmark: 'main' });
    const host = makeFakeHost({
      observations: [makeObservation({ elements: [preference, ...unknown, next] })],
    });
    const fake = makeFakeDecider({
      chooseArgument: [
        request => chooseCandidate(request, candidate => candidate.label === 'Set unchecked'),
        ...unknown.map(() =>
          deciderOk('argument', { kind: 'uncertain_requirement' as const, confidence: 0.99 })
        ),
      ],
      chooseAction: [deciderOk('action', terminal('BLOCKED'))],
    });
    const result = await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(makeRequest());
    expect(result.status).toBe('blocked');
    expect(fake.calls.verifyCompletion).toHaveLength(0);
    expect(host.calls.execute).toHaveLength(0);
    expect(fake.calls.chooseAction[0]?.request.offers.targets.SUBMIT).toEqual([]);
  });

  test.each(['all_sat', 'second_uncertain', 'second_missing'] as const)(
    'each current unresolved control must have its own real SAT proof: %s',
    async variant => {
      const preference = makeCheckbox({ state: { checked: false } });
      const controls = [
        makeSubmitButton({ id: 'lookup1', label: 'Lookup one', formId: 'f1' }),
        makeSubmitButton({ id: 'lookup2', label: 'Lookup two', formId: 'f2' }),
      ];
      const next = makeLink({ landmark: 'main' });
      const host = makeFakeHost({
        observations: [makeObservation({ elements: [preference, ...controls, next] })],
      });
      const fake = makeFakeDecider({
        chooseArgument: [
          request => chooseCandidate(request, candidate => candidate.label === 'Set unchecked'),
          ...controls.map(() =>
            deciderOk('argument', { kind: 'uncertain_requirement' as const, confidence: 0.99 })
          ),
        ],
        chooseAction: [deciderOk('action', terminal('BLOCKED'))],
        verifyCompletion: [
          request => {
            const proofs = request.unresolvedControls?.map((target, index) => ({
              target,
              verdict: (variant === 'second_uncertain' && index === 1
                ? 'UNCERTAIN'
                : 'SATISFIED') as TaskCompletionDecision['verdict'],
              confidence: 0.99,
            }));
            return deciderOk(
              'completion',
              makeCompletionDecision({
                evidenceTargetIds: [preference.id],
                unresolvedControlStates:
                  variant === 'second_missing' ? proofs?.slice(0, 1) : proofs,
              })
            );
          },
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(makeRequest());
      expect(result.status).toBe(variant === 'all_sat' ? 'completed' : 'blocked');
      expect(fake.calls.verifyCompletion).toHaveLength(1);
      expect(fake.calls.verifyCompletion[0]?.request.unresolvedControls).toHaveLength(2);
      expect(host.calls.execute).toHaveLength(0);
    }
  );

  test.each([true, false])(
    'uncertain item scope rejudges only after real preparation changes state: %s',
    async changedState => {
      const field = makeTextField({
        id: 'query',
        label: 'Search terms',
        formId: 'f1',
        commitHints: [{ class: 'FORM_SUBMIT', basis: 'implicit_submit_field' }],
      });
      const item = makeElement({
        id: 'item',
        label: 'Saved item',
        formId: 'f1',
        state: { pressed: false },
      });
      const submit = makeSubmitButton({ formId: 'f1' });
      const before = makeObservation({ elements: [item, submit, field] });
      const after = makeObservation({
        ...before,
        elements: [item, submit, { ...field, state: { ...field.state, value: 'steel' } }],
        fingerprint: 'pf_prepared',
      });
      const host = makeFakeHost({ observations: changedState ? [before, after, after] : [before] });
      let itemCalls = 0;
      const reply = (request: TaskChooseArgumentRequest) =>
        request.target?.id === field.id
          ? chooseCandidate(request, candidate => candidate.source === 'input')
          : request.target?.id === item.id
            ? deciderOk('argument', {
                kind:
                  ++itemCalls === 1
                    ? ('uncertain_requirement' as const)
                    : ('none_appropriate' as const),
                confidence: 0.99,
              })
            : chooseCandidate(request, candidate => candidate.source === 'protocol');
      const fake = makeFakeDecider({
        chooseArgument: [reply, reply, reply, reply],
        chooseAction: [deciderOk('action', terminal('BLOCKED'))],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(
        makeRequest({
          inputs: { query: 'steel' },
          options: { budgets: { maxInvalidDecisions: 0 } },
        })
      );
      expect(result.status).toBe('blocked');
      expect(fake.calls.chooseArgument.map(call => call.request.target?.id)).toEqual(
        changedState ? [field.id, item.id, submit.id, item.id] : [field.id, item.id, submit.id]
      );
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(['FILL']);
      expect(itemCalls).toBe(changedState ? 2 : 1);
      expect(fake.calls.verifyCompletion).toHaveLength(0);
    }
  );

  test('a real model commitment classification cannot turn deferred navigation into an irreversible dispatch', async () => {
    const unknown = makeCheckbox({ id: 'unknown' });
    const main = makeLink({ id: 'main', landmark: 'main' });
    const host = makeFakeHost({ observations: [makeObservation({ elements: [unknown, main] })] });
    const fake = makeFakeDecider({
      chooseArgument: [deciderOk('argument', { kind: 'uncertain_requirement', confidence: 0.99 })],
      chooseAction: [deciderOk('action', action('NAVIGATE', main.id))],
      classifyCommitment: [
        deciderOk('commitment', { commitment: 'PURCHASE', confidence: 0.99, agreement: 'agreed' }),
      ],
    });
    const result = await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(makeRequest({ options: { budgets: { maxInvalidDecisions: 0 } } }));
    expect(result.status).toBe('blocked');
    expect(fake.calls.classifyCommitment).toHaveLength(1);
    expect(host.calls.execute).toHaveLength(0);
    expect(fake.calls.verifyCompletion).toHaveLength(0);
  });

  test('a declared marker still withholds preparation while another scope judgment is unresolved', async () => {
    const field = makeTextField({
      commitHints: [{ class: 'FORM_SUBMIT', basis: 'declared_marker' }],
    });
    const unknown = makeCheckbox({ id: 'unknown' });
    const next = makeLink({ landmark: 'main' });
    const host = makeFakeHost({
      observations: [makeObservation({ elements: [field, unknown, next] })],
    });
    const fake = makeFakeDecider({
      chooseArgument: [
        request => chooseCandidate(request, candidate => candidate.source === 'input'),
        deciderOk('argument', { kind: 'uncertain_requirement', confidence: 0.99 }),
      ],
      chooseAction: [deciderOk('action', action('FILL', field.id))],
    });
    const result = await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(
      makeRequest({
        inputs: { detail: 'provided' },
        options: { budgets: { maxInvalidDecisions: 0 } },
      })
    );
    expect(result.status).toBe('blocked');
    expect(fake.calls.chooseAction[0]?.request.offers.targets.FILL).toEqual([]);
    expect(host.calls.execute).toHaveLength(0);
    expect(fake.calls.verifyCompletion).toHaveLength(0);
  });

  test.each([
    [false, 'FORM_SUBMIT'],
    [true, 'FORM_SUBMIT'],
    [false, 'PURCHASE'],
  ] as const)(
    'an independent requested form can progress without resolving another form: same form %s, commitment %s',
    async (sameForm, commitment) => {
      const field = makeTextField({ formId: 'f1', state: { value: 'retained' } });
      const submit = makeSubmitButton({ formId: 'f1' });
      const unknown = makeCheckbox({ id: 'unknown', formId: sameForm ? 'f1' : 'f2' });
      const next = makeLink({ id: 'next', landmark: 'aside' });
      const before = makeObservation({ elements: [unknown, submit, field, next] });
      const after = makeObservation({ ...before, fingerprint: 'pf_submitted' });
      const host = makeFakeHost({ observations: [before, after, after] });
      let unknownCalls = 0;
      const reply = (request: TaskChooseArgumentRequest) =>
        request.target?.id === field.id
          ? deciderOk('argument', { kind: 'keep_current' as const, confidence: 0.99 })
          : request.target?.id === submit.id
            ? chooseCandidate(request, candidate => candidate.source === 'protocol')
            : deciderOk('argument', {
                kind:
                  ++unknownCalls === 1
                    ? ('uncertain_requirement' as const)
                    : ('none_appropriate' as const),
                confidence: 0.99,
              });
      const fake = makeFakeDecider({
        chooseArgument: [reply, reply, reply, reply],
        chooseAction: [
          deciderOk('action', action('SUBMIT', submit.id)),
          deciderOk('action', terminal('BLOCKED')),
        ],
        classifyCommitment: [
          deciderOk('commitment', { commitment, confidence: 0.99, agreement: 'agreed' }),
        ],
        verifyCompletion: [
          deciderOk('completion', makeCompletionDecision({ verdict: 'UNCERTAIN' })),
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(
        makeRequest({
          authorization: { effects: ['form_submit'] },
          options: { budgets: { maxInvalidDecisions: 0 } },
        })
      );
      expect(result.status).toBe('blocked');
      const offers = fake.calls.chooseAction[0]?.request.offers;
      expect(offers?.targets.SUBMIT).toEqual(sameForm ? [] : [submit.id]);
      expect(offers?.targets.PRESS).toEqual([]);
      expect(offers?.targets.SET_CHECKED).toEqual([]);
      expect(offers?.operations).not.toContain('DONE');
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(
        !sameForm && commitment === 'FORM_SUBMIT' ? ['SUBMIT'] : []
      );
      expect(fake.calls.classifyCommitment).toHaveLength(sameForm ? 0 : 1);
    }
  );

  test('unresolved scope withholds mutation, Enter, submission and DONE despite an offered main navigation', async () => {
    const unknown = makeCheckbox({ id: 'unknown', formId: 'f1' });
    const field = makeTextField({ id: 'field', formId: 'f1', state: { value: 'retained' } });
    const submit = makeSubmitButton({ formId: 'f1' });
    const main = makeLink({ id: 'main', landmark: 'main' });
    const header = makeLink({ id: 'header', landmark: 'header' });
    const commitment = makeLink({
      id: 'commitment',
      landmark: 'main',
      commitHints: [{ class: 'PURCHASE', basis: 'declared_marker' }],
    });
    const host = makeFakeHost({
      observations: [
        makeObservation({ elements: [unknown, field, submit, main, header, commitment] }),
      ],
    });
    const reply = (request: TaskChooseArgumentRequest) =>
      request.target?.id === unknown.id
        ? deciderOk('argument', { kind: 'uncertain_requirement' as const, confidence: 0.99 })
        : request.target?.id === field.id
          ? deciderOk('argument', { kind: 'keep_current' as const, confidence: 0.99 })
          : chooseCandidate(request, candidate => candidate.source === 'protocol');
    const fake = makeFakeDecider({
      chooseArgument: [reply, reply, reply],
      chooseAction: [deciderOk('action', terminal('DONE'))],
    });
    const result = await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(makeRequest({ options: { budgets: { maxInvalidDecisions: 0 } } }));
    expect(result.status).toBe('blocked');
    const offers = fake.calls.chooseAction[0]?.request.offers;
    expect(offers?.operations).not.toContain('DONE');
    expect(offers?.targets.SUBMIT).toEqual([]);
    expect(offers?.targets.PRESS).toEqual([]);
    expect(offers?.targets.SET_CHECKED).toEqual([]);
    expect(offers?.targets.NAVIGATE).toEqual([main.id]);
    expect(host.calls.execute).toHaveLength(0);
    expect(fake.calls.verifyCompletion).toHaveLength(0);
  });

  test.each([
    ['a confident receipt keeps a pressed-state toggle clickable', {}, 0.99, ['chip']],
    ['a receipt under the argument floor keeps the toggle withheld', {}, 0.2, []],
    [
      'a commitment hint keeps the same toggle withheld',
      {
        commitHints: [{ class: 'PURCHASE' as const, basis: 'declared_marker' as const }],
      },
      0.99,
      [],
    ],
    ['a plain button never gets a click receipt and stays withheld', { state: {} }, 0.99, []],
  ])('unresolved scope and a toggle: %s', async (_name, overrides, confidence, expected) => {
    const unknown = makeCheckbox({ id: 'unknown' });
    const chip = makeElement({
      id: 'chip',
      label: 'Sonique',
      state: { pressed: false },
      ...overrides,
    });
    const main = makeLink({ id: 'main', landmark: 'main' });
    const host = makeFakeHost({
      observations: [makeObservation({ elements: [unknown, chip, main] })],
    });
    const reply = (request: TaskChooseArgumentRequest) =>
      request.target?.id === unknown.id
        ? deciderOk('argument', { kind: 'uncertain_requirement' as const, confidence: 0.99 })
        : deciderOk('argument', {
            kind: 'candidate' as const,
            candidateId:
              request.candidates.find(candidate => candidate.label === 'Set checked')?.id ?? '',
            confidence,
          });
    const fake = makeFakeDecider({
      chooseArgument: [reply, reply, reply, reply],
      chooseAction: [deciderOk('action', terminal('DONE'))],
    });
    const result = await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(makeRequest({ options: { budgets: { maxInvalidDecisions: 0 } } }));
    expect(result.status).toBe('blocked');
    const offers = fake.calls.chooseAction[0]?.request.offers;
    expect(offers?.operations).not.toContain('DONE');
    expect(offers?.targets.CLICK ?? []).toEqual(expected);
    expect(offers?.targets.SET_CHECKED).toEqual([]);
    expect(offers?.targets.PRESS ?? []).toEqual([]);
    expect(offers?.targets.SUBMIT ?? []).toEqual([]);
    expect(host.calls.execute).toHaveLength(0);
  });

  describe('a below-majority rewrite of an existing value needs an agreeing second sample', () => {
    const guests = (current: string) =>
      makeSelectField({
        id: 'guests',
        label: 'Guests',
        options: ['1', '2', '3'].map(label => ({
          id: `guests.${label}`,
          label,
          value: label,
          selected: label === current,
          disabled: false,
        })),
        state: { value: current },
      });
    type Sample = (
      request: TaskChooseArgumentRequest
    ) => ReturnType<typeof deciderOk<TaskArgumentDecision>>;
    const pickLabel =
      (label: string, confidence: number): Sample =>
      request => {
        const candidate = request.candidates.find(item => item.label === label);
        return deciderOk('argument', {
          kind: 'candidate',
          candidateId: candidate?.id ?? '',
          confidence,
        });
      };
    const keep =
      (confidence: number): Sample =>
      () =>
        deciderOk('argument', { kind: 'keep_current', confidence });
    const run = async (current: string, script: readonly Sample[]) => {
      const main = makeLink({ id: 'main', landmark: 'main' });
      const host = makeFakeHost({
        observations: [makeObservation({ elements: [guests(current), main] })],
      });
      const fake = makeFakeDecider({
        chooseArgument: [...script, keep(0.9), keep(0.9)],
        chooseAction: [deciderOk('action', terminal('BLOCKED'))],
        classifyCommitment: [
          deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
        ],
      });
      await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(
        makeRequest({
          goal: 'Set the guests to 2.',
          options: { budgets: { maxInvalidDecisions: 0 }, confidence: { argument: 0.3 } },
        })
      );
      return { fake, host };
    };

    test.each([
      [
        'an agreeing second sample lets the rewrite stand',
        [pickLabel('2', 0.4), pickLabel('2', 0.6)],
        2,
        ['SELECT'],
      ],
      ['a second sample that keeps the value wins', [pickLabel('2', 0.4), keep(0.7)], 2, []],
      [
        'a second sample that picks the current option wins',
        [pickLabel('2', 0.4), pickLabel('1', 0.6)],
        2,
        [],
      ],
      [
        'a second sample that rewrites differently leaves it uncertain',
        [pickLabel('2', 0.4), pickLabel('3', 0.6)],
        2,
        [],
      ],
      [
        'a second sample under the floor leaves it uncertain',
        [pickLabel('2', 0.4), pickLabel('2', 0.1)],
        2,
        [],
      ],
      ['a majority-confident rewrite is not resampled', [pickLabel('2', 0.6)], 1, ['SELECT']],
    ] as const)('%s', async (_name, script, samples, operations) => {
      const { fake, host } = await run('1', script);
      expect(fake.calls.chooseArgument).toHaveLength(samples);
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(operations);
    });

    test('a sub-floor rewrite followed by an agreeing second sample still stands on two samples', async () => {
      const { fake, host } = await run('1', [pickLabel('2', 0.2), pickLabel('2', 0.4)]);
      expect(fake.calls.chooseArgument).toHaveLength(2);
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(['SELECT']);
    });

    describe('text fields', () => {
      const runFill = async (
        sensitive: boolean,
        script: readonly ((
          request: TaskChooseArgumentRequest
        ) => ReturnType<typeof deciderOk<TaskArgumentDecision>>)[]
      ) => {
        const field = makeTextField({
          id: 'name',
          label: 'Name',
          sensitive,
          state: { value: 'Grace Hopper' },
        });
        const main = makeLink({ id: 'main', landmark: 'main' });
        const host = makeFakeHost({
          observations: [makeObservation({ elements: [field, main] })],
        });
        const fake = makeFakeDecider({
          chooseArgument: [...script, keep(0.9), keep(0.9)],
          chooseAction: [deciderOk('action', terminal('BLOCKED'))],
          classifyCommitment: [
            deciderOk('commitment', { commitment: 'NONE', confidence: 0.99, agreement: 'single' }),
          ],
        });
        await createTaskAgent({
          host: host.host,
          decider: { ...fake.decider, supportsRequirements: true },
        }).run(
          makeRequest({
            goal: 'Fill my supplied name.',
            inputs: { profile: { name: 'Ada Lovelace' } },
            options: { budgets: { maxInvalidDecisions: 0 }, confidence: { argument: 0.3 } },
          })
        );
        return { fake, host };
      };
      const pickInput =
        (confidence: number): Sample =>
        request =>
          deciderOk('argument', {
            kind: 'candidate',
            candidateId: request.candidates.find(item => item.source === 'input')?.id ?? '',
            confidence,
          });

      test('a below-majority overwrite of a different text value needs the second sample to agree', async () => {
        const kept = await runFill(false, [pickInput(0.4), keep(0.7)]);
        expect(kept.fake.calls.chooseArgument).toHaveLength(2);
        expect(kept.host.calls.execute).toHaveLength(0);
        const agreed = await runFill(false, [pickInput(0.4), pickInput(0.6)]);
        expect(agreed.fake.calls.chooseArgument).toHaveLength(2);
        expect(agreed.host.calls.execute.map(request => request.command.operation)).toEqual([
          'FILL',
        ]);
      });

      test('a sensitive element never takes the consensus path', async () => {
        const { fake } = await runFill(true, [pickInput(0.4)]);
        expect(fake.calls.chooseArgument).toHaveLength(1);
      });
    });

    test('filling a placeholder-valued select is not a rewrite and is not resampled', async () => {
      const { fake, host } = await run('', [pickLabel('2', 0.4)]);
      expect(fake.calls.chooseArgument).toHaveLength(1);
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(['SELECT']);
    });
  });

  test.each([
    ['a second sample that agrees and clears the floor is used', 0.9, 'same', true],
    ['a second sample that is still under the floor changes nothing', 0.2, 'same', false],
    ['a second sample that chooses differently changes nothing', 0.9, 'other', false],
  ])('borderline requirement judgment: %s', async (_name, secondConfidence, which, fills) => {
    const field = makeTextField({ id: 'name', label: 'Name', state: { value: '' } });
    const main = makeLink({ id: 'main', landmark: 'main' });
    const host = makeFakeHost({
      observations: [makeObservation({ elements: [field, main] })],
    });
    const pick = (confidence: number, index: number) => (request: TaskChooseArgumentRequest) =>
      deciderOk('argument', {
        kind: 'candidate' as const,
        candidateId:
          request.candidates.filter(candidate => candidate.source === 'input')[index]?.id ?? '',
        confidence,
      });
    const fake = makeFakeDecider({
      chooseArgument: [
        pick(0.2, 0),
        pick(secondConfidence, which === 'same' ? 0 : 1),
        pick(0.2, 0),
        pick(0.2, 0),
      ],
      chooseAction: [deciderOk('action', terminal('BLOCKED'))],
    });
    await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(
      makeRequest({
        goal: 'Fill my supplied details.',
        inputs: { profile: { name: 'Ada Lovelace', city: 'London' } },
        options: { budgets: { maxInvalidDecisions: 0 } },
      })
    );
    expect(fake.calls.chooseArgument).toHaveLength(2);
    expect(host.calls.execute.map(request => request.command.operation)).toEqual(
      fills ? ['FILL'] : []
    );
  });

  test.each([
    [
      'a more confident second sample choosing supplied data fills the blank field',
      0.64,
      'input',
      0.9,
      true,
    ],
    [
      'a second sample that is less confident than the first keep leaves it blank',
      0.64,
      'input',
      0.5,
      false,
    ],
    [
      'a confident honored prohibition is not overridden by a lower second sample',
      0.95,
      'input',
      0.9,
      false,
    ],
    ['a second sample that also keeps the field leaves it blank', 0.64, 'keep', 0.9, false],
    [
      'a second sample choosing a non-supplied candidate leaves it blank',
      0.64,
      'literal',
      0.9,
      false,
    ],
  ])(
    'relevant blank field kept empty: %s',
    async (_name, firstKeep, second, secondConfidence, fills) => {
      const field = makeTextField({
        id: 'phone',
        label: 'Phone (optional)',
        inputType: 'tel',
        state: { value: '' },
      });
      const host = makeFakeHost({ observations: [makeObservation({ elements: [field] })] });
      const keep = (confidence: number) =>
        deciderOk('argument', { kind: 'keep_current' as const, confidence });
      const take = (source: string) => (request: TaskChooseArgumentRequest) =>
        deciderOk('argument', {
          kind: 'candidate' as const,
          candidateId: request.candidates.find(candidate => candidate.source === source)?.id ?? '',
          confidence: secondConfidence,
        });
      const fake = makeFakeDecider({
        chooseArgument: [
          keep(firstKeep),
          second === 'keep' ? keep(0.9) : take(second),
          keep(firstKeep),
          keep(firstKeep),
        ],
        chooseAction: [deciderOk('action', terminal('BLOCKED'))],
      });
      await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(
        makeRequest({
          goal: 'Send my order to my profile address.',
          inputs: { profile: { phone: '+1 303 555 0153' } },
        })
      );
      expect(host.calls.execute.map(request => request.command.operation)).toEqual(
        fills ? ['FILL'] : []
      );
    }
  );

  test.each([
    ['a weak BLOCKED followed by a usable operation continues with it', 0.3, 'read', true],
    ['a weak BLOCKED confirmed by a second BLOCKED still blocks', 0.3, 'blocked', false],
    ['a confident BLOCKED is not asked twice', 0.9, 'read', false],
  ])('BLOCKED confirmation: %s', async (_name, blockedConfidence, second, continues) => {
    const passage = makePassage();
    const host = makeFakeHost({ observations: [makeObservation({ elements: [passage] })] });
    const blocked = deciderOk('action', {
      ...terminal('BLOCKED'),
      confidence: blockedConfidence,
      operationConfidence: blockedConfidence,
    });
    const fake = makeFakeDecider({
      chooseAction: [
        blocked,
        second === 'read' ? deciderOk('action', action('READ', passage.id)) : blocked,
        deciderOk('action', terminal('BLOCKED')),
        deciderOk('action', terminal('BLOCKED')),
      ],
    });
    const result = await createTaskAgent({ host: host.host, decider: fake.decider }).run(
      makeRequest({ goal: 'Read the shipping policy.' })
    );
    expect(host.calls.execute.map(request => request.command.operation)).toEqual(
      continues ? ['READ'] : []
    );
    if (!continues) expect(result.status).toBe('blocked');
    expect(fake.calls.chooseAction.length).toBeGreaterThanOrEqual(blockedConfidence < 0.5 ? 2 : 1);
  });

  test('volatile text after a READ cannot repeatedly requery unresolved scope without preparation progress', async () => {
    const unknown = makeCheckbox({ id: 'unknown' });
    const main = makeLink({ id: 'main', landmark: 'main' });
    const passage = makePassage();
    const before = makeObservation({ elements: [unknown, main, passage] });
    const changed = makeObservation({ ...before, fingerprint: 'pf_volatile_text' });
    const host = makeFakeHost({ observations: [before, changed, changed] });
    const fake = makeFakeDecider({
      chooseArgument: [deciderOk('argument', { kind: 'uncertain_requirement', confidence: 0.99 })],
      chooseAction: [
        deciderOk('action', action('READ', passage.id)),
        deciderOk('action', terminal('BLOCKED')),
      ],
    });
    const result = await createTaskAgent({
      host: host.host,
      decider: { ...fake.decider, supportsRequirements: true },
    }).run(makeRequest());
    expect(result.status).toBe('blocked');
    expect(fake.calls.chooseArgument).toHaveLength(1);
    expect(host.calls.execute.map(request => request.command.operation)).toEqual(['READ']);
    expect(fake.calls.verifyCompletion).toHaveLength(0);
  });

  test.each(['SATISFIED', 'UNCERTAIN'] as const)(
    'BLOCKED with satisfied observed requirements still needs a real completion verdict: %s',
    async verdict => {
      const preference = makeCheckbox({ label: 'Promotional emails', state: { checked: false } });
      const host = makeFakeHost({ observations: [makeObservation({ elements: [preference] })] });
      const fake = makeFakeDecider({
        chooseArgument: [
          request => chooseCandidate(request, candidate => candidate.label === 'Set unchecked'),
        ],
        chooseAction: [deciderOk('action', terminal('BLOCKED'))],
        verifyCompletion: [
          deciderOk(
            'completion',
            makeCompletionDecision({
              verdict,
              evidenceTargetIds: verdict === 'SATISFIED' ? [preference.id] : [],
            })
          ),
        ],
      });
      const result = await createTaskAgent({
        host: host.host,
        decider: { ...fake.decider, supportsRequirements: true },
      }).run(makeRequest({ goal: 'Keep promotional emails turned off.' }));
      expect(result.status).toBe(verdict === 'SATISFIED' ? 'completed' : 'blocked');
      expect(fake.calls.verifyCompletion).toHaveLength(1);
      expect(fake.calls.chooseAction).toHaveLength(verdict === 'SATISFIED' ? 0 : 1);
      expect(host.calls.execute).toHaveLength(0);
      if (result.status === 'completed') expect(result.completion.mode).toBe('noop');
    }
  );

  test('number words are verified representations of exact goal ranges, not invented data', () => {
    const goal = 'Change the quantity to two.';
    const element = makeTextField({ inputType: 'number' });
    const pool = buildCandidates({
      goal,
      operation: 'FILL',
      slot: 'value',
      element,
      observation: makeObservation({ elements: [element] }),
      capabilities: makeCapabilities(),
      leaves: [],
      resolvers: [],
      origins: [],
      limit: 100,
    });
    const candidate = pool.candidates.find(item => item.preview === '2');
    if (
      !candidate ||
      (candidate.ref.source !== 'goal_literal' && candidate.ref.source !== 'goal_span')
    )
      throw new Error('numeric candidate unavailable');
    expect(goalRefMatches(candidate.ref, goal)).toBe(true);
    expect(
      materializeArgument(candidate.ref, { goal, inputs: {}, declarations: [], resolved: {} })
    ).toMatchObject({ ok: true, value: '2' });
    expect(goalRefMatches({ ...candidate.ref, text: 'three' }, goal)).toBe(false);
    expect(
      goalRefMatches(
        {
          ...candidate.ref,
          text: 'quantity',
          start: goal.indexOf('quantity'),
          end: goal.indexOf('quantity') + 8,
        },
        goal
      )
    ).toBe(false);
  });

  test('keeping a state and satisfying a requested value use current observation data', () => {
    const field = makeTextField({ state: { value: 'old' } });
    const key = goalRequirementKey(field);
    const context = { goal: 'Keep the field unchanged.', inputs: {}, declarations: [], ledger: [] };
    const requirement = {
      key,
      operation: 'FILL' as const,
      label: field.label,
      sensitive: false,
      preserve: { value: 'old' },
    };
    expect(goalRequirementHolds(requirement, field, context)).toBe(true);
    expect(
      goalRequirementHolds(
        requirement,
        { ...field, state: { ...field.state, value: 'changed' } },
        context
      )
    ).toBe(false);
  });
});
