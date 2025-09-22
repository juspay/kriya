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

```
User Message → Your AI → Action Commands → Kriya Executes
```

Example:
1. User: "Fill the registration form with John Doe"
2. Your AI: `[{type: "fillForm", parameters: {"fields": "{\"name\": \"John Doe\"}"}}]`
3. Kriya: Executes form filling automatically

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
engine.addEventListener('action_completed', (event) => {
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
      { role: 'system', content: 'You are a web automation assistant. Return action commands as JSON.' },
      { role: 'user', content: `${message}\n\nPage context: ${JSON.stringify(context)}` }
    ]
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
  timeout: number;              // Default action timeout (5000ms)
  retryAttempts: number;        // Retry failed actions (3)
  screenshotOnError: boolean;   // Capture screenshots on errors (true)
  debugMode: boolean;           // Enable debug logging (false)
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
automationEngine.addEventListener('form_filled', (event) => {
  console.log(`Filled ${event.data.fieldsCount} fields`);
});

automationEngine.addEventListener('action_failed', (event) => {
  console.error('Action failed:', event.data.error);
});

automationEngine.addEventListener('screenshot_taken', (event) => {
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

## License

MIT