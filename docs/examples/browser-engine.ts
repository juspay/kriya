import { createAutomationEngine } from '@juspay/kriya';

/** Call after the integration owns a mounted DOM root containing one #name input. */
export async function fillName(root: HTMLElement) {
  const engine = createAutomationEngine({
    root,
    debugMode: false,
    screenshotOnError: false,
  });
  engine.initialize();
  try {
    const target = root.querySelector<HTMLInputElement>('#name');
    if (target === null) {
      return { success: false, reason: 'missing_name_field' } as const;
    }
    return await engine.executeAction(
      { type: 'fill', parameters: { strict: 'true', value: 'Ada Lovelace' } },
      { target }
    );
  } finally {
    engine.dispose();
  }
}
