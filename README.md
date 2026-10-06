# @juspay/kriya

Pure automation execution engine for web actions - no AI, no UI. Execute action commands from any AI (OpenAI, Claude, Gemini, etc.) and handle web automation tasks.

## Overview

Kriya is a TypeScript library that takes action commands from ANY AI and executes web automation tasks like clicking, filling forms, navigation, and capturing page context. It provides a clean separation between AI decision-making and automation execution.

## Features

- ✅ **Execute action commands** from any AI provider
- ✅ **Form detection and registration** with automatic field mapping
- ✅ **DOM element finding** with smart description matching
- ✅ **Screenshot capture** with html2canvas integration
- ✅ **Page context extraction** for AI analysis
- ✅ **Click guide** that highlights the next control for a goal in plain language
- ✅ **Event system** for monitoring automation progress
- ✅ **TypeScript support** with strict type safety
- ✅ **Production ready** with comprehensive error handling

## Installation

```bash
npm install @juspay/kriya
```

## Quick Start

```typescript
import { createAutomationEngine } from '@juspay/kriya';

// Initialize the automation engine
const automationEngine = createAutomationEngine({
  timeout: 5000,
  debugMode: false,
  screenshotOnError: true,
});

automationEngine.initialize();

// Execute actions from your AI
const actions = [
  {
    type: 'fillForm',
    parameters: {
      fields: JSON.stringify({
        email: 'user@example.com',
        password: 'secret123',
      }),
    },
  },
  {
    type: 'submitForm',
    parameters: {},
  },
];

const results = await automationEngine.executeActions(actions);
console.log('Automation results:', results);
```

## Core Concepts

### Scoped DOM and embedded navigation

Pass `root` to scope element lookup, form detection, labels, focus and utility DOM to a
`Document`, `ShadowRoot` or `Element`. An element root includes the element itself and its
descendants. Queries and parent traversal stay inside that root; they do not pierce nested
shadow trees or fall back to the host document. Manually registered forms must also belong
to the configured root. Screenshots target the element root or a shadow root's host.

```typescript
const engine = createAutomationEngine({
  root: appElement.shadowRoot!,
  locationProvider: {
    getHref: () => appRouter.currentUrl,
    getTitle: () => appRouter.currentTitle,
    navigate: async url => {
      await appRouter.navigate(url);
    },
  },
});
engine.initialize();
```

`locationProvider.getHref()` is read on every capture and when resolving relative links.
Return an absolute URL so relative links resolve against the app route.
`getTitle()` is optional and defaults to the root's owner document title. `navigate(url)`
may return void or a Promise; its Promise defines route completion, including when an
action requests `waitForLoad`. Navigation errors become the existing `NETWORK_ERROR`
result. Without a provider, navigation retains its window location and load-event behavior.
Provider navigation also honors the action timeout.
Provider-backed anchor hrefs are resolved before synthetic dispatch, then restored. App
handlers can cancel navigation normally. Scoped clicks use native anchor activation once;
they do not retry a canceled click or manually open an extra window.

With an explicit root, synthetic click, input, change and keyboard events bubble and are
composed. Native shadow form submissions are forwarded once as composed, cancellable
submit events, preserving their submitter and propagating cancellation back to the native
event. Form listeners are removed on disposal. Without these options, document targeting,
default configuration and event flags retain their existing behavior.

The exported types are `AutomationRoot` and `AutomationLocationProvider`; the same options
are available in the ReScript `automationConfig` binding. This additive `feat` API is
expected in the next minor release after 1.1.1; it has not been published by this change.

### 1. Action Commands

Action commands are simple JSON objects that describe what to do:

```typescript
interface ActionCommand {
  type: 'navigate' | 'click' | 'fill' | 'fillForm' | 'submitForm' | 'screenshot' | 'wait';
  parameters: Record<string, string>;
  timeout?: number;
  description?: string;
}
```

### 2. User Flow

```text
User Message → Your AI → Action Commands → Kriya Executes
```

Example:

1. User: "Fill the registration form with John Doe"
2. Your AI: `[{type: "fillForm", parameters: {"fields": "{\"name\": \"John Doe\"}"}}]`
3. Kriya: Executes form filling automatically

## Click guide

Say what you are looking for. Kriya lists the controls actually on the page, asks a decider which one is the next step, and highlights it. You click. Kriya reads the page again and moves the highlight. It does not click for you.

The decider is injected, same as the rest of Kriya. `createTypeSafeDecider` is the TypeSafe Jev adapter: one `choice` for the operation and one `choice` for the target, in a single request.

```typescript
import { createClickGuide, createTypeSafeDecider } from '@juspay/kriya';

const guide = createClickGuide();
const decide = createTypeSafeDecider({
  apiKey: process.env.TYPESAFE_API_KEY ?? '',
});

const step = await guide.start('turn off email notifications', decide);
// step.label is the control now outlined on the page.
// A click on that control asks for the next one.
// guide.stop() removes the outline.
```

`mountJevGuide` puts the same loop on the page as a command bar. With an API key it asks Jev. The outline eases from one control to the next, and the corner chip shows how long the decision took.

```typescript
import { mountJevGuide } from '@juspay/kriya';

const session = mountJevGuide({ apiKey: process.env.TYPESAFE_API_KEY ?? '' });
await session.submit('turn off email notifications');
```

Open `examples/jev-stage.html` to watch the outline move. That page uses a local stand-in until a TypeSafe key is supplied.

`createResearchGuide` investigates one yes/no question. Each turn sends that same question, the current page, available actions, collected passages, and action history to Jev. Jev selects what to read or where to navigate and decides when it has enough evidence to answer. There are no checkpoints, supplied destinations, expected phrases, or required number of pages. Read-only exploration may proceed with uncertain action choices; the final answer requires confidence of at least 0.60. Previously tried navigation actions and already collected passages are excluded from later choices.

`examples/breeze-jev.mjs` records the question “Does breeze.in offer one-click checkout?” with live Jev requests. It uses the existing browser tools and brand assets in `/tmp/amazon-guide` by default (`BREEZE_GUIDE_TOOLS_DIR` can override that directory):

```bash
node --env-file=/path/to/private.env examples/breeze-jev.mjs
```

The env file must supply `TYPESAFE_API_KEY` or `JEV_API_KEY`. The key stays in Node; the page sends its observations through a binding, and Node calls the [TypeSafe API](https://docs.typesafe.ai/api). Requests, responses, decisions, and verification frames go into `/tmp/amazon-guide/jev-verification/`. A successful live run updates `examples/breeze-automatic.mp4`; failed runs retain their own failure video. `BREEZE_GUIDE_QUESTION` changes the question, and `--no-publish` keeps a test run separate from the main video. The browser remains on breeze.in and excludes shopping, docs, directory embeds, and external navigation. This is an informational investigation and does not execute a purchase.

Any function with the `GuideDecider` shape can stand in for Jev. A decider must choose an offered operation and, when required, an index from the corresponding target question.

## API Reference

### AutomationEngine

The main class for executing automation tasks.

```typescript
const engine = createAutomationEngine(config);

// Initialize with optional form library
engine.initialize(formLibrary);

// Execute single action
const result = await engine.executeAction(action);

// Execute multiple actions
const results = await engine.executeActions(actions);

// Capture page context for AI
const context = await engine.capturePageContext();

// Register forms manually
engine.registerForm('login-form', formElement);

// Event handling
engine.addEventListener('action_completed', event => {
  console.log('Action completed:', event);
});
```

### Action Types

#### Navigate

```typescript
{
  type: 'navigate',
  parameters: {
    url: 'https://example.com',
    waitForLoad: 'true'
  }
}
```

#### Click Elements

```typescript
{
  type: 'click',
  parameters: {
    selector: 'button.submit',
    // OR
    description: 'submit button'
  }
}
```

#### Fill Form Fields

```typescript
{
  type: 'fill',
  parameters: {
    selector: 'input[name="email"]',
    value: 'user@example.com',
    clearFirst: 'true'
  }
}
```

#### Fill Entire Forms

```typescript
{
  type: 'fillForm',
  parameters: {
    fields: JSON.stringify({
      email: 'user@example.com',
      password: 'secret123',
      fullName: 'John Doe'
    })
  }
}
```

#### Submit Forms

```typescript
{
  type: 'submitForm',
  parameters: {
    formId: 'optional-form-id'
  }
}
```

#### Take Screenshots

```typescript
{
  type: 'screenshot',
  parameters: {
    fullPage: 'true',
    quality: '0.9'
  }
}
```

#### Wait/Delay

```typescript
{
  type: 'wait',
  parameters: {
    duration: '2000',
    // OR
    selector: '.loading',
    condition: 'hidden'
  }
}
```

## Integration Examples

### With OpenAI

```typescript
import OpenAI from 'openai';
import { createAutomationEngine } from '@juspay/kriya';

const openai = new OpenAI({ apiKey: 'your-key' });
const automationEngine = createAutomationEngine();

async function handleUserMessage(message: string) {
  // 1. Capture page context
  const context = await automationEngine.capturePageContext();

  // 2. Send to OpenAI
  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      {
        role: 'system',
        content: 'You are a web automation assistant. Return action commands as JSON.',
      },
      {
        role: 'user',
        content: `${message}\n\nPage context: ${JSON.stringify(context)}`,
      },
    ],
  });

  // 3. Execute actions
  const actions = JSON.parse(completion.choices[0].message.content);
  const results = await automationEngine.executeActions(actions);

  return results;
}
```

### With React Final Form

```typescript
import { createAutomationEngine } from '@juspay/kriya';

// React component
function MyForm() {
  const formRef = useRef(null);

  useEffect(() => {
    if (formRef.current) {
      automationEngine.registerForm('my-form', formRef.current);

      return () => {
        automationEngine.unregisterForm('my-form');
      };
    }
  }, []);

  return (
    <form ref={formRef}>
      {/* Your form fields */}
    </form>
  );
}
```

## Configuration

```typescript
interface AutomationConfig {
  timeout: number; // Default action timeout (5000ms)
  retryAttempts: number; // Retry failed actions (3)
  screenshotOnError: boolean; // Capture screenshots on errors (true)
  debugMode: boolean; // Enable debug logging (false)
  formDetectionEnabled: boolean; // Auto-detect forms (true)
  contextCaptureEnabled: boolean; // Enable context capture (true)
}
```

## Error Handling

```typescript
try {
  const result = await automationEngine.executeAction(action);

  if (!result.success) {
    console.error('Action failed:', result.error, result.errorCode);
  }
} catch (error) {
  if (error instanceof AutomationError) {
    console.error('Automation error:', error.code, error.message);
  }
}
```

## Events

Monitor automation progress with event listeners:

```typescript
automationEngine.addEventListener('form_filled', event => {
  console.log(`Filled ${event.data.fieldsCount} fields`);
});

automationEngine.addEventListener('action_failed', event => {
  console.error('Action failed:', event.data.error);
});

automationEngine.addEventListener('screenshot_taken', event => {
  console.log('Screenshot captured:', event.data.width, 'x', event.data.height);
});
```

## Browser Support

- Chrome 80+
- Firefox 75+
- Safari 13+
- Edge 80+

## TypeScript Support

Fully typed with strict TypeScript configuration. No `any` types in production code.

## ReScript Support

Kriya ships first-class ReScript bindings in the `rescript/` folder. No need to hand-roll your own.

**Requirements:** `rescript >= 11` and `@rescript/core >= 1.0`.

**Setup** — in your own `rescript.json`:

```json
{
  "bs-dependencies": ["@rescript/core", "@juspay/kriya"],
  "bsc-flags": ["-open RescriptCore"]
}
```

**Usage:**

```rescript
open Kriya

let engine = createEngine(~debugMode=true, ~timeout=10000)
engine->initialize

let result = await engine->executeAction(navigate(~url="https://example.com"))

// Fill a form by dict
let fields = Dict.fromArray([("name", "Alice"), ("email", "alice@example.com")])
let _ = await engine->executeFormFill(~fields)

engine->disposeEngine
```

Everything the TypeScript API exposes has a ReScript binding — action builders (`navigate`, `click`, `fill`, `wait`, `press`, `screenshot`, `submitForm`, `fillForm`), engine lifecycle, event listeners, page-context capture, and screenshot capture.

## License

MIT
