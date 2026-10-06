# Kriya - TypeScript Coding Standards

## Project Overview

Kriya is a pure automation execution engine for web actions. It executes action commands from ANY AI (OpenAI, Claude, Gemini, etc.) and handles web automation tasks like clicking, filling forms, navigation, and capturing page context.

## STRICT Code Conventions (MUST follow)

### 1. NEVER use `interface` — always use `type`

This project uses `type` exclusively. Do NOT create `interface` declarations anywhere. This includes:

- Exported types: `export type Foo = { ... };` (NOT `export interface Foo { ... }`)
- Local types: `type Bar = { ... };` (NOT `interface Bar { ... }`)
- Function-scoped types: same rule applies inside functions

**Why:** `type` is more flexible (unions, intersections, mapped types, conditional types) and the project has standardized on it for consistency. The ESLint rule `@typescript-eslint/consistent-type-definitions: ['error', 'type']` enforces this mechanically — do not disable it.

### 2. ALL exported type definitions go in `src/types/` — NEVER in feature folders

- ALL `export type` declarations MUST live in `src/types/*.ts`
- Do NOT create `types/` directories inside feature folders (e.g., NEVER create `src/forms/types/forms.types.ts`)
- Do NOT create files named `*.types.ts` — just use the domain name: `src/types/forms.ts`
- Re-export everything from `src/types/index.ts` so consumers can import via `import type { Foo } from '@/types'`
- File-private helper types used only within a single file (e.g., a React fiber shape used by one detector) may stay inline as `type` aliases — but must still be `type`, never `interface`
- Function-scoped types used only within a single function body may stay inline

**Existing type files (reference):**

```text
src/types/
├── actions.ts           # ActionCommand, ExecutionResult, Click/Fill/Wait/PressOptions, etc.
├── context.ts           # PageContext, ElementContext, ScreenshotOptions, ViewportInfo, etc.
├── core.ts              # AutomationConfig, WebAutomataAPI, DEFAULT_CONFIG
├── errors.ts            # ErrorCode, AutomationError
├── events.ts            # EventType, AutomationEvent, EventCallback
├── forms.ts             # FormAPI, FormContext, FormFieldContext, FormRegistryConfig, etc.
├── react-internals.ts   # ReactFiberNode — shared fiber-walker shape
└── index.ts             # Barrel re-exports
```

**When adding new types:** Find the most relevant existing file in `src/types/` and add there. Only create a new file if no existing file fits the domain.

## TypeScript Coding Standards

### 1. Strict Type Safety

- **ALWAYS use explicit types** - Never use `any` or implicit types
- **Use strict TypeScript configuration** with `strict: true`, `noImplicitAny: true`, `noImplicitReturns: true`
- **Generic constraints** when using generics, always specify bounds
- **Discriminated unions** for action types and state management
- **Type guards** for runtime type checking and validation

### 2. Code Quality Rules

- **No warnings allowed** - Code must compile with zero TypeScript warnings
- **No `console.log`** in production code - Use proper logging only when necessary
- **No excessive comments** - Code should be self-documenting with clear naming
- **No `@ts-ignore`** - Fix type issues properly instead of suppressing
- **Error handling** - All async operations must have proper error handling

### 3. Naming Conventions

- **Classes**: PascalCase (e.g., `ActionExecutor`, `FormRegistry`)
- **Interfaces**: PascalCase with descriptive names (e.g., `ActionCommand`, `FormFieldValue`)
- **Types**: PascalCase (e.g., `ExecutionResult`, `PageContext`)
- **Functions/Methods**: camelCase with verb prefixes (e.g., `executeAction`, `captureContext`)
- **Variables**: camelCase, descriptive and concise
- **Constants**: SCREAMING_SNAKE_CASE (e.g., `DEFAULT_TIMEOUT`, `MAX_RETRIES`)
- **Private members**: prefix with underscore (e.g., `_registry`, `_validateAction`)

### 4. Architecture Patterns

- **Single Responsibility Principle** - Each class/module has one clear purpose
- **Dependency Injection** - Use constructor injection for dependencies
- **Promise-based APIs** - All async operations return properly typed Promises
- **Builder Pattern** - For complex object creation (e.g., action commands)
- **Strategy Pattern** - For different execution strategies
- **Observer Pattern** - For event handling and callbacks

### 5. File Organization

```text
src/
├── types/          # The ONLY location for exported type definitions (see STRICT Conventions above)
├── core/           # Core automation engine
├── actions/        # Action execution logic
├── forms/          # Form handling and registry
├── context/        # Page context and capture
└── utils/          # Utility functions
```

### 6. Import/Export Rules

- **Named exports only** - No default exports
- **Barrel exports** - Use `src/types/index.ts` to re-export all public types; other modules import via `import type { Foo } from '@/types'`
- **Relative imports** within modules, absolute (`@/…`) for cross-module
- **Type-only imports** — use `import type { Foo } from '@/types'` when importing only types

### 7. Error Handling

- **Custom Error classes** with specific error types
- **Result pattern** for operations that can fail
- **Never throw in library code** - Return error results instead
- **Proper async error handling** with try/catch blocks

### 8. Performance Guidelines

- **Lazy loading** - Initialize heavy resources only when needed
- **Memory management** - Clean up event listeners and references
- **Efficient DOM operations** - Batch DOM reads/writes
- **Debouncing** for frequent operations like form filling

### 9. Testing Requirements

- **100% type coverage** - No `any` types in production code
- **Unit tests** for all public methods
- **Integration tests** for complete workflows
- **Mock external dependencies** (DOM, network, etc.)

### 10. Production Readiness

- **No development artifacts** in build output
- **Minified and tree-shakeable** - Support modern bundlers
- **Browser compatibility** - Target ES2020+ with proper polyfills
- **Size optimization** - Keep bundle size minimal
- **Security considerations** - Validate all inputs, sanitize outputs

## Code Examples

### Type Definition

```typescript
export type ActionCommand = {
  readonly type: 'navigate' | 'click' | 'fill' | 'fillForm' | 'submitForm';
  readonly parameters: Readonly<Record<string, string>>;
  readonly timeout?: number;
};

export type ExecutionResult =
  | { success: true; data?: unknown }
  | { success: false; error: string; code: ErrorCode };
```

### Class Implementation

```typescript
export class ActionExecutor {
  private readonly _timeout: number;
  private readonly _validator: ActionValidator;

  constructor(config: ExecutorConfig) {
    this._timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this._validator = new ActionValidator(config.validationRules);
  }

  async executeAction(action: ActionCommand): Promise<ExecutionResult> {
    const validation = this._validator.validate(action);
    if (!validation.success) {
      return {
        success: false,
        error: validation.error,
        code: 'INVALID_ACTION',
      };
    }

    try {
      const result = await this._performAction(action);
      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        code: 'EXECUTION_FAILED',
      };
    }
  }

  private async _performAction(action: ActionCommand): Promise<unknown> {
    // Implementation details
  }
}
```

### Error Handling

```typescript
class AutomationError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AutomationError';
  }
}

type ErrorCode =
  | 'INVALID_ACTION'
  | 'ELEMENT_NOT_FOUND'
  | 'FORM_NOT_REGISTERED'
  | 'EXECUTION_TIMEOUT'
  | 'NETWORK_ERROR';
```

## Key Principles

1. **Type safety over runtime flexibility**
2. **Explicit over implicit**
3. **Fail fast and fail clearly**
4. **Immutable data structures where possible**
5. **Pure functions without side effects**
6. **Composable and testable design**

## Forbidden Patterns

- ❌ `interface` declarations — use `type` aliases (enforced by ESLint)
- ❌ `export type` outside `src/types/`
- ❌ `*.types.ts` filenames (use the bare domain name — `forms.ts`, not `forms.types.ts`)
- ❌ `any` type usage
- ❌ `console.log` in production
- ❌ Mutable global state
- ❌ Throwing errors in library code
- ❌ Implicit type coercion
- ❌ Side effects in pure functions
- ❌ Nested callback patterns (use async/await)
- ❌ Direct DOM manipulation without validation

## TaskAgent additions

The general task coordinator lives in `src/agent/`; only `src/agent/browser/` may access browser globals. The public contract is `docs/task-agent-contract.md` and `src/types/agent.ts`. Keep sensitive values as references until authorized execution and verify completion from a fresh observation. Use `npx tsc --noEmit --incremental false` to avoid shared build-info races.
