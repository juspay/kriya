# Privacy, policy and completion verification

Kriya separates model decisions from authorized execution. Your application remains responsible
for authentication, consent, session isolation, backend authorization and sensitive-data retention.
A page's text is untrusted evidence, including instructions it may contain.

## Keep secrets at the execution boundary

Declare sensitive input paths and bind them to allowed origins/target kinds. Sensitive fields are
restricted to sensitive targets by default. Filling a public text field with private data requires
an explicit binding with requireSensitiveElement false and nonempty origins; make that decision
in trusted application code. A secret must not appear in the literal goal, because the unchanged
goal is included in every model question.

The decider sees opaque sensitive references. The coordinator materializes a value only after
policy allows the command and checks authoritative location again before sending it. The execute
payload then necessarily contains that value. Never log raw transport payloads; use redactEnvelope.
The application must also protect browser network logs, request recordings and screenshots.
Byte scans cannot establish pixel secrecy or catch all page-masked/re-encoded values.

## Transport trust

Controller location must come from outside the page realm, such as Playwright page.url(), not a
page-writable object. Reinstall a bridge for every document and validate its protocol/identity.
Lost execution contexts can leave uncertain effects. Do not replay a mutation automatically.
Main-world bridge execution is not isolation against a malicious site; isolated-world deployments
need their own verified controller implementation.

Optional HTTP hooks, resolvers, verifiers and trace sinks are trusted application code. Do not expose
provider credentials to arbitrary plugins. Kriya does not enforce an application-wide HTTP egress
allowlist or browser-level sandbox on your behalf.

## What completed means

DONE is a proposal. The coordinator obtains a fresh observation and checks requirements, action
postconditions, unresolved uncertain effects, applicable persistence evidence, cited evidence and
an independent completion decision. An engine action returning success does not itself complete
a TaskAgent goal. Completion may legitimately report a NO answer for a read-only question.

A local edited control and a success toast do not prove a durable write. Use the scoped independent
GET view when safe, or a caller verifier that reads authoritative backend state. Configure a verifier
under createTaskAgent options; it receives the literal goal, fresh observation, ledger and signal.
Return SATISFIED only when the requested record/state is independently established, NOT_SATISFIED
when contradicted, and UNCERTAIN when unavailable. A verifier can veto completion; SATISFIED alone
cannot bypass the other gates. Backend verification must use the same authenticated account and
request identifier as the task rather than an unrelated successful record.

Model confidence is a stage threshold, not a guarantee. A changed model, prompt, UI, provider or
confidence profile needs application acceptance tests. Prefix acceptance validates a returned label;
it does not establish provider identity, routing or calibration.

See [operations](operations.md) for fault controls and [lifecycle](lifecycle.md) for approvals,
checkpoint integrity and uncertain-effect resolution.
