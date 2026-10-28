# Examples

Standalone demonstrations for @juspay/kriya. They are not part of the package build and are not
type-checked or linted by the repository gates; the checked, shipped examples live in
`docs/examples/` and are exercised by `pnpm run docs:verify`.

| File                | What it shows                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `basic-usage.ts`    | Creating an automation engine from source and dispatching typed actions                       |
| `click-guide.ts`    | Driving the click guide with the TypeSafe decider (needs `TYPESAFE_API_KEY`)                  |
| `task-agent.mjs`    | Running the compiled TaskAgent against the controlled settings app with real Chromium and Jev |
| `breeze-jev.mjs`    | Recording a live Breeze walkthrough with Jev decisions (needs `TYPESAFE_API_KEY`)             |
| `breeze-chrome.mjs` | Shared presentation layer used by the Breeze recording                                        |
| `jev-stage.html`    | Static stage page used by the Breeze recording                                                |

Run the Node demos from the repository root after `pnpm install --frozen-lockfile && pnpm run build`, for example:

```bash
node --env-file=/path/to/private.env examples/task-agent.mjs
```

Live demos call a paid provider; nothing here runs without an explicit key. When adding an example,
keep it self-contained, handle errors explicitly and describe it in this table.
