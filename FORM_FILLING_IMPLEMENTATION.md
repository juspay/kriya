# Form implementation reference

Form detection and registration live in src/forms, action dispatch in src/actions, and page/context
capture in src/context. These components feed the browser TaskHost but do not replace its strict
target, policy or completion checks. See the [engine guide](docs/integration/browser-engine.md)
and [public TaskAgent contract](docs/task-agent-contract.md) for supported behavior.

The earlier implementation narrative is available in Git history. Application-private React/SelectBox
heuristics are compatibility paths, not a guarantee that every framework widget can be automated.
