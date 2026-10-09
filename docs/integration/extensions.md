# Custom deciders, hosts and research

The package exports TaskDecider, TaskHost, TaskResolver, TaskVerifier and their request/result types.
Use these typed seams when integrating an existing agent framework, extension or provider.
The built-in implementation is a TypeSafe Choice adapter; it is not a general text-generation SDK.

## Custom decision provider

Implement chooseAction, chooseArgument and verifyCompletion with structured TaskDeciderResult values
and exchange metadata. Select only current offered operations, targets and candidate ids. Preserve
the literal goal in every question, validate response vocabulary/confidence and propagate cancellation.
Missing classifyCommitment is not assumed routine: applicable operations fail closed as an unknown
commitment unless the caller explicitly chooses weaker behavior. Advertise supportsRequirements
only when chooseArgument implements requirement, activation, group and validation assessments.

A compatible provider's endpoint/model/prefix can be configured explicitly in the TypeSafe adapter.
That only validates the wire shape and reported label. Confidence semantics and task acceptance need
separate measurements. Probability/profile diagnostics are opt-in and do not change policy or DONE gates.

The NeuroLink/Perplexity investigation is an offline integration preparation, not a bundled, live-accepted
provider adapter. Do not advertise production Perplexity task accuracy from prefix or fake-HTTP checks.
A paid run needs its own cost authorization and acceptance record.

## Resolvers and application verification

A resolver can derive data from a trusted application source when its operation/slot declarations
permit it. Return typed available/unavailable results and provenance; do not turn a resolver into
an unbounded model writer or expose secrets in candidate labels. The caller verifier checks resulting
state; it does not supply new action authorization. See the contract for their exact shapes.

## Custom host and transport

Implement observation, execution, capabilities, authoritative location where available, and cleanup.
Use truthful none/applied/uncertain effects and reject stale references. A transport is JSON-only;
AbortSignal and credentials remain controller-side. Test navigation loss, cancellation order,
late executes after cancellation, stale snapshots, origin changes and malformed responses before
advertising capabilities. The documented Playwright template is one controller implementation.

## Research and guided UI

`createResearchRequest(question)` restricts TaskAgent to READ/NAVIGATE/SCROLL/WAIT and requires an answer.
`toResearchResult(result)` maps the task result to the research result shape. It is not unrestricted
web browsing with form writes. The older ClickGuide/ResearchGuide and highlight utilities remain
separate public APIs for guided UI integrations; using the new task adapter does not rewrite their
lifecycle or credential choices. Assess those integrations independently before exposing them to users.
