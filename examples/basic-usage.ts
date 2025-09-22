import { createAutomationEngine } from '../src/index';
import type { ActionCommand } from '../src/types';

async function basicExample(): Promise<void> {
  const automationEngine = createAutomationEngine({
    timeout: 5000,
    debugMode: true,
    screenshotOnError: true,
  });

  try {
    automationEngine.initialize();

    const pageContext = await automationEngine.capturePageContext();
    // eslint-disable-next-line no-console
    console.log('Captured page context:', pageContext);

    const fillFormAction: ActionCommand = {
      type: 'fillForm',
      parameters: {
        fields: JSON.stringify({
          username: 'john.doe@example.com',
          password: 'secretPassword123',
          fullName: 'John Doe',
        }),
      },
    };

    const fillResult = await automationEngine.executeAction(fillFormAction);
    // eslint-disable-next-line no-console
    console.log('Form fill result:', fillResult);

    if (fillResult.success) {
      const submitAction: ActionCommand = {
        type: 'submitForm',
        parameters: {},
      };

      const submitResult = await automationEngine.executeAction(submitAction);
      // eslint-disable-next-line no-console
      console.log('Form submit result:', submitResult);
    }

    const screenshot = await automationEngine.captureScreenshot();
    // eslint-disable-next-line no-console
    console.log('Screenshot captured, length:', screenshot.length);

  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Automation error:', error);
  } finally {
    automationEngine.dispose();
  }
}

async function multipleActionsExample(): Promise<void> {
  const automationEngine = createAutomationEngine();

  try {
    automationEngine.initialize();

    const actions: ActionCommand[] = [
      {
        type: 'click',
        parameters: {
          description: 'login button',
        },
      },
      {
        type: 'fill',
        parameters: {
          selector: 'input[name="email"]',
          value: 'user@example.com',
        },
      },
      {
        type: 'fill',
        parameters: {
          selector: 'input[type="password"]',
          value: 'password123',
        },
      },
      {
        type: 'click',
        parameters: {
          selector: 'button[type="submit"]',
        },
      },
    ];

    const results = await automationEngine.executeActions(actions);
    
    results.forEach((result, index) => {
      // eslint-disable-next-line no-console
      console.log(`Action ${index + 1} result:`, result);
    });

  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Automation error:', error);
  } finally {
    automationEngine.dispose();
  }
}

async function eventListenerExample(): Promise<void> {
  const automationEngine = createAutomationEngine();

  automationEngine.addEventListener('action_started', (event) => {
    // eslint-disable-next-line no-console
    console.log('Action started:', event);
  });

  automationEngine.addEventListener('action_completed', (event) => {
    // eslint-disable-next-line no-console
    console.log('Action completed:', event);
  });

  automationEngine.addEventListener('form_filled', (event) => {
    // eslint-disable-next-line no-console
    console.log('Form filled:', event);
  });

  try {
    automationEngine.initialize();

    const action: ActionCommand = {
      type: 'fillForm',
      parameters: {
        fields: JSON.stringify({
          email: 'test@example.com',
          message: 'Hello from automation!',
        }),
      },
    };

    await automationEngine.executeAction(action);

  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Automation error:', error);
  } finally {
    automationEngine.dispose();
  }
}

export { basicExample, multipleActionsExample, eventListenerExample };