import { createClickGuide, createTypeSafeDecider } from '@juspay/kriya';

const apiKey = process.env.TYPESAFE_API_KEY ?? '';

const guide = createClickGuide();
const decide = createTypeSafeDecider({ apiKey });

const first = await guide.start('turn off email notifications', decide);
console.info(first.ok ? `Next click: ${first.label ?? first.operation}` : first.error);
