# Node and Playwright integration

Keep the coordinator, checkpoint state and provider credential in Node. The browser receives the
UMD execution bundle and one bridge per document. RemoteTaskHost uses a controller transport to
observe, execute and rediscover the bridge after navigation.

## Install and initialize

In your own Node ESM project:

```sh
npm install @juspay/kriya playwright
npx playwright install chromium
```

Copy `task-agent-node.mjs` and `playwright-transport.mjs` from the package's `docs/examples/`
into the same application directory. The transport is an integration template, not a separately
exported library module. The acceptance harness imports this same file so its controls exercise
what the guide recommends.

Create `run.mjs` beside those files:

```javascript
import { chromium } from 'playwright';
import { createBrowserTaskAgent } from './task-agent-node.mjs';

const startUrl = process.env.KRIYA_START_URL;
if (!startUrl || !process.env.TYPESAFE_API_KEY) {
  throw new Error('Set KRIYA_START_URL and load TYPESAFE_API_KEY in Node.');
}
const origin = new URL(startUrl).origin;
const browser = await chromium.launch();
const context = await browser.newContext({ serviceWorkers: 'block' });
const page = await context.newPage();
let host;
try {
  const integration = await createBrowserTaskAgent({
    context,
    page,
    allowedOrigins: [origin],
  });
  host = integration.host;
  // Establish your application's authenticated session before starting the task.
  await page.goto(startUrl);
  const result = await integration.agent.run({
    goal: 'Find the available delivery options without submitting an order.',
    startUrl,
    expect: { answer: false },
    authorization: { origins: [origin] },
  });
  process.stdout.write(
    JSON.stringify({ status: result.status, lastEffect: result.lastEffect }) + '\n'
  );
  // Send paused results to your input/approval UI; see the lifecycle guide.
} finally {
  await host?.dispose();
  await context.close();
  await browser.close();
}
```

Load a private file with Node's `--env-file=/absolute/path/to/private.env` option. Kriya does not
read it itself. Set `KRIYA_START_URL` from trusted integration configuration to your authorized application. If an incoming user request supplies the URL, validate it against a separate configured origin allowlist before creating the context or request; do not authorize it by deriving that allowlist from the supplied URL. Running this example calls
TypeSafe and may incur provider charges. Its result depends on the application and model judgments;
it is not the credential-free verification test.

## Transport responsibilities

The supplied template sends JSON envelopes to `__kriyaTaskBridge.invoke`, obtains location from
`page.url()` outside the page realm and supports concurrent cancellation. It preserves lost calls
as `kind: 'lost'`; a destroyed execution context is not evidence that no action occurred.
It never automatically retries an execution payload. Redacted tracing is optional; raw FILL
payloads must not be logged. Use a dedicated browser context and block service workers for this template.

Register the init script **before** the first navigation; adding an init script does not retrofit
an already-loaded document. Bridge installation refuses a conflicting existing global and non-top
frames. Wait for a ready document and keep origin ceilings aligned with the run's authorization.
RemoteTaskHost defaults to 10-second RPC calls, 15-second navigation discovery and a 2-second
cancel grace period.

## Independent saved-state reads

The template's optional `refresh` obtains the exact current authorized view using GET, refuses
redirects, checks the URL including its hash, and requires a new document identity. It does not
replay a POST. It can reset tabs or collapsed sections while saved values remain correct.
This path requires NAVIGATE authorization and a GET-readable view. Reloads can trigger application
side effects outside Kriya's knowledge: use it only where GET is safe in your application.

If refresh is unsuitable, omit that capability and provide an authoritative caller verifier through
`createTaskAgent({ options: { verifier } })`. A verifier's SATISFIED result supplies independent
persistence evidence but does not bypass the model verifier or other completion gates.

The template uses the page's main world and reports no isolated-world guarantee. For untrusted
sites, assess the stronger extension/CDP isolation and transport contract your deployment needs.
See [security](security.md) and the [public contract](../task-agent-contract.md).
