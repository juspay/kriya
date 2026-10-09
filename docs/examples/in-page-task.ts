import {
  createAutomationEngine,
  createAutomationTaskHost,
  createRedactor,
  createTaskAgent,
} from '@juspay/kriya';
import type { TaskDecider } from '@juspay/kriya';

/** decider is a trusted typed RPC client. Never put a provider credential in this page. */
export function createPageAgent(decider: TaskDecider) {
  const engine = createAutomationEngine({
    debugMode: false,
    screenshotOnError: false,
    redactor: createRedactor(),
  });
  engine.initialize();
  const host = createAutomationTaskHost({ executor: engine });
  const agent = createTaskAgent({ host, decider });
  return {
    agent,
    /** Releases host snapshots and engine listeners when the owning view unmounts. */
    async dispose() {
      await host.dispose();
      engine.dispose();
    },
  };
}
