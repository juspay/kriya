# How Form Filling Works in Kriya

This document explains the comprehensive form filling mechanism in the Kriya automation framework, covering both standard HTML forms and complex ReScript/React components.

## Architecture Overview

The form filling system is built around 4 key components:

```
AutomationEngine
    ↓
ActionExecutor  
    ↓
FormRegistry + DOMActions
    ↓
DOM Elements (Standard HTML + ReScript Components)
```

## Core Components

### 1. AutomationEngine
- **Role**: Main orchestrator and entry point
- **Responsibilities**:
  - Initializes all subsystems
  - Validates actions before execution
  - Emits events for monitoring
  - Manages overall lifecycle

### 2. ActionExecutor  
- **Role**: Action coordination and timeout management
- **Responsibilities**:
  - Routes actions to appropriate handlers
  - Applies timeouts to prevent hanging
  - Handles error capture and screenshots
  - Manages action execution lifecycle

### 3. FormRegistry
- **Role**: Form-aware filling with intelligent field mapping
- **Responsibilities**:
  - Auto-detects forms on page initialization
  - Registers forms for targeted filling
  - Maps field names to actual DOM elements
  - Provides both targeted (`fillForm`) and smart (`fillAnyForm`) filling
  - Handles form submission

### 4. DOMActions
- **Role**: Low-level DOM manipulation and element detection
- **Responsibilities**:
  - Direct element interaction (click, fill, wait)
  - Advanced element detection using multiple strategies
  - ReScript component support
  - Event triggering for framework compatibility

## Form Filling Workflows

### Method 1: Direct Element Filling (via DOMActions)

```typescript
// Single field filling
await engine.executeAction({
  type: 'fill',
  parameters: {
    selector: '#email',           // CSS selector
    description: 'Email field',   // Alternative: natural language description
    value: 'user@example.com',
    clearFirst: 'true',          // Clear before filling
    triggerEvents: 'true'        // Trigger input/change events
  }
});
```

**How it works:**
1. `ActionExecutor` receives the fill action
2. Creates `FillOptions` from parameters
3. Calls `DOMActions.fill()`
4. `DOMActions._findElement()` locates the target using:
   - CSS selector (if provided)
   - Natural language description matching
5. Validates element is fillable
6. Calls `_fillElement()` with appropriate strategy

### Method 2: Form-Aware Filling (via FormRegistry)

```typescript
// Form registration (auto-detected on initialization)
engine.registerForm('loginForm', document.getElementById('login-form'));

// Fill specific form
await engine.executeAction({
  type: 'fillForm',
  parameters: {
    formId: 'loginForm',  // Optional - will auto-detect if omitted
    fields: JSON.stringify({
      'email': 'user@example.com',
      'password': 'secretpass',
      'country': 'India'
    })
  }
});
```

**How it works:**
1. `ActionExecutor` parses the `fillForm` action
2. Calls `FormRegistry.fillForm()` or `FormRegistry.fillAnyForm()`
3. FormRegistry uses intelligent field matching strategies
4. For each field, calls the native FormAPI or falls back to enhanced DOMActions
5. Batches all changes and triggers appropriate events

## Element Detection Strategies

### Standard HTML Elements

DOMActions uses multiple detection strategies in order of priority:

```typescript
// 1. Direct CSS selector
element = document.querySelector(selector);

// 2. Natural language description matching
element = this._findElementByDescription(description);
```

The description matching calculates scores based on:
- **Exact text matches** (highest priority)
- **Breadcrumb navigation** (`data-breadcrumb` attributes)
- **Button text** (`data-button-text` attributes) 
- **Accessibility labels** (`aria-label`, `title`)
- **Form labels** (associated `<label>` elements)
- **Placeholder text**
- **Data attributes** (`data-testid`, `data-name`, etc.)
- **Element semantics** (clickable vs fillable prioritization)

### ReScript/Euler Dashboard Components

Special handling for complex ReScript components:

#### SelectBox Components
```typescript
// Detection patterns:
- data-selectbox-value attribute
- data-button-text within buttons
- Semantic class names (selectbox, dropdown, combobox)
- Button elements with data-value attributes
```

**SelectBox Filling Process:**
1. Detect SelectBox container via `data-selectbox-value`
2. Find trigger button with `data-value` attribute
3. Click button to open dropdown
4. Wait for dropdown to render (`data-dropdown="dropdown"`)
5. Search for target option using multiple strategies:
   - Exact `data-dropdown-value` match
   - Text content matching (case-insensitive)
   - Partial text matching
6. Click selected option
7. Update button state and trigger change events

#### FormRenderer Fields
```typescript
// Detection patterns:
- data-component-field-wrapper attribute
- data-form-label attributes
- field-renderer, form-field class names
```

## Field Mapping Strategies (FormRegistry)

FormRegistry provides intelligent field mapping using multiple fallback strategies:

### Strategy 1: Direct Name Matching
```html
<input name="email" />
<!-- Maps to field: "email" -->
```

### Strategy 2: Data Attribute Mapping  
```html
<div data-component-field-wrapper="email">
  <input />
</div>
<!-- Maps to field: "email" -->
```

### Strategy 3: Prefixed Field Mapping
```html
<div data-component-field-wrapper="field-email">
  <input />  
</div>
<!-- Maps to field: "email" (strips "field-" prefix) -->
```

### Strategy 4: Global Search
If not found within the form, searches globally across the page for matching elements.

## Event Handling & Framework Compatibility

The system ensures compatibility with modern frameworks by triggering appropriate events:

```typescript
// Standard events for React/Vue compatibility
element.dispatchEvent(new Event('input', { bubbles: true }));
element.dispatchEvent(new Event('change', { bubbles: true }));
element.dispatchEvent(new Event('blur', { bubbles: true }));

// Custom events for ReScript components
element.dispatchEvent(new CustomEvent('select', { 
  detail: { value: selectedValue },
  bubbles: true 
}));
```

## Error Handling & Recovery

### Validation Levels
1. **Action validation** - Ensures required parameters are present
2. **Element detection** - Multiple fallback strategies before failing
3. **Execution validation** - Confirms element is actually fillable/clickable
4. **Framework compatibility** - Handles both standard HTML and custom components

### Automatic Recovery
- **Clickable element search**: If element isn't directly clickable, searches for clickable parents/children
- **SelectBox fallbacks**: Multiple option matching strategies (exact → partial → text content)
- **Global field search**: Falls back to page-wide search if not found in specific form
- **Multiple form strategies**: `fillAnyForm()` finds best matching form automatically

## Usage Examples

### Complete Login Flow
```typescript
const engine = new AutomationEngine();
engine.initialize();

// Fill login form
await engine.executeAction({
  type: 'fillForm',
  parameters: {
    fields: JSON.stringify({
      'email': 'john@example.com',
      'password': 'mypassword'
    })
  }
});

// Submit form
await engine.executeAction({
  type: 'submitForm',
  parameters: {}
});
```

### Mixed HTML + ReScript Components
```typescript
// Fill regular input
await engine.executeAction({
  type: 'fill',
  parameters: {
    selector: '#user-name',
    value: 'John Doe'
  }
});

// Fill ReScript SelectBox
await engine.executeAction({
  type: 'fill',
  parameters: {
    description: 'Country selection',  // Uses natural language
    value: 'India'
  }
});

// Fill using form registry
await engine.executeAction({
  type: 'fillForm',
  parameters: {
    fields: JSON.stringify({
      'user-name': 'John Doe',
      'country': 'India',
      'date-of-birth': '1990-01-01'
    })
  }
});
```

## Configuration Options

```typescript
const config = {
  timeout: 10000,           // Default timeout for operations
  debugMode: true,          // Enhanced error reporting
  screenshotOnError: true,  // Capture screenshots on failures
  retryAttempts: 3,         // Retry failed operations
  autoDetectForms: true     // Auto-register forms on page load
};

const engine = new AutomationEngine(config);
```

## Best Practices

### 1. Prefer Form-Level Operations
```typescript
// ✅ Good - handles all fields in one operation
await engine.executeAction({
  type: 'fillForm',
  parameters: { fields: JSON.stringify(allFields) }
});

// ❌ Avoid - multiple separate operations
for (const [field, value] of Object.entries(fields)) {
  await engine.executeAction({
    type: 'fill',
    parameters: { selector: `[name="${field}"]`, value }
  });
}
```

### 2. Use Natural Language Descriptions
```typescript
// ✅ Good - works across different implementations
await engine.executeAction({
  type: 'fill',
  parameters: {
    description: 'Email address',
    value: 'user@example.com'
  }
});

// ⚠️ Fragile - breaks if implementation changes
await engine.executeAction({
  type: 'fill', 
  parameters: {
    selector: '#form_field_email_input_wrapper div input',
    value: 'user@example.com'
  }
});
```

### 3. Leverage Auto-Detection
```typescript
// ✅ Good - automatically finds the best form
await engine.executeAction({
  type: 'fillForm',
  parameters: {
    fields: JSON.stringify(fields)  // No formId needed
  }
});
```

### 4. Handle Async Components
```typescript
// Wait for dynamic content to load
await engine.executeAction({
  type: 'wait',
  parameters: {
    selector: '[data-selectbox-value]',
    condition: 'visible',
    timeout: 5000
  }
});

// Then fill the component
await engine.executeAction({
  type: 'fill',
  parameters: {
    description: 'Country selection',
    value: 'India'
  }
});
```

This comprehensive form filling system provides robust automation capabilities for both standard web forms and complex modern web applications with custom components.
