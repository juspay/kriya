import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRemoteTaskHost,
  createTaskAgent,
  createTypeSafeTaskDecider,
  redactEnvelope,
} from '@juspay/kriya';
import { createPlaywrightTransport } from './playwright-transport.mjs';

/** The caller owns authentication, page navigation, the browser context and its lifetime. */
export async function createBrowserTaskAgent({ context, page, allowedOrigins, decider }) {
  const packageRoot = dirname(fileURLToPath(import.meta.resolve('@juspay/kriya/package.json')));
  const umd = await readFile(join(packageRoot, 'dist/index.umd.js'), 'utf8');
  // Register before the first navigation. The bridge initializes at DOMContentLoaded.
  await context.addInitScript({
    content: `${umd}\n;WebAutomata.installTaskBridge({allowedOrigins:${JSON.stringify(allowedOrigins)}});`,
  });
  const host = createRemoteTaskHost({
    transport: createPlaywrightTransport({ page, redactEnvelope }),
  });
  const agent = createTaskAgent({
    host,
    decider:
      decider ??
      createTypeSafeTaskDecider({
        apiKey: () => process.env.TYPESAFE_API_KEY ?? '',
      }),
  });
  return { agent, host };
}
