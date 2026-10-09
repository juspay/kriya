# Migration and compatibility

## TaskAgent and action failure results

Version 2 adds the general TaskAgent coordinator and its host/decider/policy seams.
Existing engine and guide entrypoints remain. Action failures now fulfill with a structured
ExecutionResult instead of rejecting for normal action failures. Update catch-only callers to
inspect result.success, error and effect. A cancelled/failed command may already have an effect.

TaskAgent commands use uppercase typed operations and opaque snapshot references. Engine actions
use lowercase names and string-valued parameters. Do not pass one directly as the other.
New strict target, press, select, checked-state and scroll fields have dedicated validation/errors.

## Removing bundled ReScript bindings

The next release removes rescript/Kriya.res, rescript.json, the ReScript build step and optional
ReScript peer declarations. ReScript consumers depending on those files must keep a compatible
older package or own a binding to the supported JavaScript/TypeScript API. This is a breaking
package-surface removal and must be released with a major version, not disguised as documentation-only.
No runtime JavaScript entrypoint is removed by this cleanup.

React and React Final Form peer declarations are also removed because Kriya does not import either
package. Existing duck-typed form detection remains and still needs application-specific validation.
The screenshot implementation retains html2canvas. Development-only tooling changes do not add
provider SDKs or browser binaries to the consumer package.

## Configuration and packaging

The old config/default.json scaffold was never loaded by the library. Configuration is passed
through typed constructors/requests; consumers should not rely on automatic NODE_ENV file merging.
Reproducible dist files are allowlisted in the npm tarball; TypeScript build caches and generated
API/site output are excluded. Integration guides and example source remain included.

Use named imports from @juspay/kriya. The existing default engine export remains for compatibility,
but new integrations should use the named API. See the integration index for placement/lifetime
choices before moving an in-page integration to Node.
