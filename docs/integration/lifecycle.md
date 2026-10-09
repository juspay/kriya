# Application lifecycle and result handling

Create one agent per active task session. Only one run can be active on an agent; concurrent
run/resume attempts fail with RUN_IN_PROGRESS. Store the result and inspect its discriminated status.

| Status            | Application behavior                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| completed         | Show the checked outcome and optional YES/NO answer; retain relevant evidence                           |
| needs_input       | Ask for the listed requirements and resume its checkpoint with kind inputs                              |
| awaiting_approval | Show the concrete command, effects, origin and reviewed context; record an authenticated decision       |
| blocked           | Explain the reason and reconcile unsupported surfaces, policy, confidence, budgets or uncertain effects |
| failed            | Inspect error.code/stage/retryable; do not automatically replay a possibly applied write                |
| cancelled         | Show cancellation with lastEffect and unresolvedUncertain; cancellation is not rollback                 |

## Inputs and permissions

Pass structured data in `inputs`. Declare private leaves with `inputDeclarations`, including paths,
sensitivity and target/origin bindings. Public inputs are previewed by default; use `expose: 'label'`
or `inputPreviews: false` to reduce projection. Missing required data is a paused task rather than
permission to invent it. A resolver may supply values only for its declared operations/slots.

Set `startUrl` and explicit `authorization.origins`. Operation authorization is intersected with
host capabilities and any profile. Routine effects need no commitment grant. External commitments
need grants for their exact effects, such as `form_submit`, `account_change` or `purchase`, or a bound
approval. Grants can restrict origins, signatures, expiry and maxUses. Broad grants are application
consent decisions; a task's natural language alone does not authorize every commitment.

## A private input request

This request builder validates the caller-selected URL against an independently trusted application
origin. Configure ACCOUNT_ORIGIN from trusted application settings; never derive the allowlist from
the URL being validated, page content or model output. A public email control needs the explicit
requireSensitiveElement false widening shown here. The caller must already have consent for the two
narrow effect grants; otherwise omit them and handle awaiting_approval.

```typescript
import type { TaskRequest } from '@juspay/kriya';

const ACCOUNT_ORIGIN = 'https://account.example.test';

/** Builds a consented request only for the independently configured account application. */
export function emailUpdateRequest(startUrl: string, email: string): TaskRequest {
  if (new URL(startUrl).origin !== ACCOUNT_ORIGIN) {
    throw new Error('Start URL is outside the configured account origin.');
  }
  const origin = ACCOUNT_ORIGIN;
  return {
    goal: 'Update my account email to the supplied profile email and save it.',
    startUrl,
    expect: { answer: false },
    inputs: { profile: { email } },
    inputDeclarations: [
      {
        path: 'profile.email',
        sensitive: true,
        description: 'New account email',
        bind: { origins: [origin], inputTypes: ['email'], requireSensitiveElement: false },
      },
    ],
    authorization: {
      origins: [origin],
      effects: [
        { effect: 'account_change', maxUses: 1 },
        { effect: 'form_submit', maxUses: 1 },
      ],
    },
    options: { requireGroundedCompletion: true },
  };
}
```

Run this through an authoritative remote host and configure independent saved-state verification.
The goal contains no email value; the decision provider receives an opaque sensitive reference.

## Approval and resume

Use the complete [approval helper](../examples/approval.ts) only after your real UI obtains a
user decision. It echoes approval id, nonce, command digest and context digest, with scope once.
Never synthesize consent from a model judgment or auto-approve every paused result.
On resume the coordinator reobserves the page, checks the reviewed context and consumes the approval
before dispatch. A changed target, value, document or context can require a new decision/approval.

For missing data, resume with `resolution: { kind: 'inputs', inputs: suppliedValues }`.
Sensitive leaves are omitted from checkpoints: resupply them through resume inputs or declare them
unavailable with omitSensitivePaths. Omitting them silently is not equivalent to a refusal.
An independently checked uncertain ledger entry can be resolved with kind effect, ledgerSeq and
applied/not_applied. Never choose not_applied merely because an HTTP/transport call timed out.

## Checkpoint storage

The default checkpoint registry belongs to the issuing agent instance. For cross-process resume,
configure a private checkpointKey and durable, atomic consumeApproval hook. Do not put either in
the page. Bind checkpoint storage and approval decisions to your authenticated user and task.
A checkpoint is integrity-checked, not encrypted: non-sensitive caller data and history can contain
personal information. Apply access controls, retention and deletion rules. Checkpoints carrying
priorEffects remain tied to their issuing instance.

Resume can tighten budgets/timeouts and raise confidence/evidence requirements. It cannot restore
spent budgets, broaden scope or relax a saved guard. Treat checkpoints as opaque integrity-protected
objects rather than editable task plans.

## Cancellation and cleanup

Pass an AbortSignal to run/resume, or call `agent.cancel(runId?)`. Propagation is cooperative across
observation, decision and execution. Remote cancellation needs a concurrent transport; an abort is
not proof that a dispatched action had no effect. Inspect lastEffect (`none`, `applied`, `uncertain`)
and unresolvedUncertain before starting another task.

The caller owns and closes its browser/context. Dispose the host and any separately created engine
when finished. Paused runs release snapshots and reobserve on resume; do not retain live DOM targets
as durable identifiers across documents.
