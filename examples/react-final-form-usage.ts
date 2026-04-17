import { createAutomationEngine } from '../src/index';

// Create automation engine instance
const engine = createAutomationEngine({
  timeout: 10000,
  debugMode: true, // Enable console logging to see React Final Form detection
  formDetectionEnabled: true,
});

// Initialize the engine (this will auto-detect forms on the page)
engine.initialize();

/**
 * Example 1: Fill Any Form (Automatic Detection)
 *
 * This will automatically:
 * 1. Detect React Final Form vs native forms
 * 2. Use formApi.initialize() for React Final Form (efficient bulk filling)
 * 3. Fall back to formApi.change() for native forms
 */
async function fillAnyFormExample() {
  try {
    const result = await engine.executeAction({
      type: 'fillForm',
      parameters: {
        fields: JSON.stringify({
          // These values will be applied as "initial values"
          // for React Final Form using formApi.initialize()
          firstName: 'John',
          lastName: 'Doe',
          email: 'john.doe@example.com',
          phone: '+1-555-0123',
          country: 'United States',
          city: 'New York',
        }),
      },
    });

    console.log('Form fill result:', result);

    if (result.success) {
      console.log(`✅ Successfully filled ${result.data.filledFields.length} fields`);
      console.log('Filled fields:', result.data.filledFields);
    } else {
      console.log('❌ Form filling failed:', result.error);
      if (result.data.failedFields.length > 0) {
        console.log('Failed fields:', result.data.failedFields);
      }
    }
  } catch (error) {
    console.error('Error filling form:', error);
  }
}

/**
 * Example 2: Fill Specific Form by ID
 */
async function fillSpecificFormExample() {
  try {
    const result = await engine.executeAction({
      type: 'fillForm',
      parameters: {
        formId: 'user-registration-form', // Target specific form
        fields: JSON.stringify({
          username: 'johndoe123',
          password: 'securePassword',
          confirmPassword: 'securePassword',
          agreeToTerms: 'true',
          newsletter: 'false',
        }),
      },
    });

    console.log('Specific form fill result:', result);
  } catch (error) {
    console.error('Error filling specific form:', error);
  }
}

/**
 * Example 3: Submit Form After Filling
 */
async function fillAndSubmitExample() {
  try {
    // First fill the form
    const fillResult = await engine.executeAction({
      type: 'fillForm',
      parameters: {
        fields: JSON.stringify({
          loginEmail: 'user@example.com',
          loginPassword: 'myPassword123',
        }),
      },
    });

    if (fillResult.success) {
      console.log('✅ Form filled successfully, now submitting...');

      // Then submit the form
      const submitResult = await engine.executeAction({
        type: 'submitForm',
        parameters: {}, // Will submit the first available form
      });

      if (submitResult.success) {
        console.log('✅ Form submitted successfully');
      } else {
        console.log('❌ Form submission failed:', submitResult.error);
      }
    }
  } catch (error) {
    console.error('Error in fill and submit:', error);
  }
}

/**
 * Example 4: Capture Page Context to See Detected Forms
 */
async function captureFormsExample() {
  try {
    const context = await engine.capturePageContext();

    console.log(`📊 Page Analysis:`);
    console.log(`- Total forms found: ${context.totalFormsFound}`);
    console.log(`- Registered forms: ${context.forms.length}`);

    context.forms.forEach((form, index) => {
      console.log(`\n📝 Form ${index + 1}:`);
      console.log(`  - ID: ${form.formId}`);
      console.log(`  - Method: ${form.method}`);
      console.log(`  - Fields: ${form.fields.length}`);
      console.log(`  - Has Submit Button: ${form.hasSubmitButton}`);

      // Show field details
      form.fields.forEach(field => {
        console.log(`    • ${field.name} (${field.type})${field.required ? ' *required' : ''}`);
      });
    });
  } catch (error) {
    console.error('Error capturing context:', error);
  }
}

/**
 * Example 5: React Final Form with Complex Field Types
 */
async function complexFieldTypesExample() {
  try {
    const result = await engine.executeAction({
      type: 'fillForm',
      parameters: {
        fields: JSON.stringify({
          // Text inputs
          fullName: 'John William Doe',
          bio: 'Software engineer with 5+ years of experience...',

          // Select/Dropdown fields (including ReScript SelectBox components)
          country: 'United States',
          state: 'California',
          jobTitle: 'Senior Developer',

          // Number inputs
          age: '30',
          salary: '120000',

          // Boolean/Checkbox inputs
          isActive: 'true',
          receiveEmails: 'false',
          agreeToTerms: 'true',

          // Date inputs
          birthDate: '1994-01-15',
          startDate: '2024-01-01',

          // Array/Multi-select (will be converted appropriately)
          skills: 'JavaScript,TypeScript,React,ReScript',
          languages: 'English,Spanish',
        }),
      },
    });

    console.log('Complex form fill result:', result);
  } catch (error) {
    console.error('Error filling complex form:', error);
  }
}

// Export examples for use
export {
  fillAnyFormExample,
  fillSpecificFormExample,
  fillAndSubmitExample,
  captureFormsExample,
  complexFieldTypesExample,
};

/**
 * Usage in browser console or application:
 *
 * // Basic usage
 * fillAnyFormExample();
 *
 * // Or run all examples
 * async function runAllExamples() {
 *   await captureFormsExample();     // See what forms are detected
 *   await fillAnyFormExample();      // Fill a form automatically
 *   await fillSpecificFormExample(); // Fill specific form
 *   await complexFieldTypesExample(); // Test complex field types
 * }
 *
 * runAllExamples();
 */

/**
 * Console Output Examples:
 *
 * When React Final Form is detected:
 * ✅ Found React Final Form API, using enhanced API
 * 🚀 Filling form auto-detected-form-0 with 6 fields
 * ✨ Using React Final Form initialize() for efficient bulk filling
 * ✅ Successfully initialized 6 fields via initialize()
 * 📊 Form fill result: 6/6 fields filled successfully
 *
 * When native form is detected:
 * 🔄 No React Final Form detected, creating native wrapper API
 * 🚀 Filling form auto-detected-form-1 with 4 fields
 * 🔄 Using individual field changes (no initialize method available)
 * ✅ Changed field "email"
 * ✅ Changed field "password"
 * 📊 Form fill result: 4/4 fields filled successfully
 */
