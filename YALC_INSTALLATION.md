# Testing a local package

Use a real package tarball to reproduce what an integrator installs:

```sh
npm run build
npm run verify:package
npm pack
```

Install the emitted tgz in an isolated consumer with npm install /absolute/path/to/package.tgz.
The consumer gate already checks ESM, CommonJS and types without publishing. Kriya no longer
requires yalc or a ReScript dashboard to validate a local package. See CONTRIBUTING.md for the
complete integration/browser checks.
