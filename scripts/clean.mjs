import { rm } from 'node:fs/promises';

// Only reproducible package output owned by this checkout.
await Promise.all(
  ['dist', '.rollup.cache'].map(path => rm(path, { recursive: true, force: true }))
);
