# TaskAgent capability recordings

Build the package, then run `e2e/demos/run.mjs` with an absolute, unused output directory
outside the repository. Load the TypeSafe credential through Node's `--env-file` option.
The script never reads an environment file or copies a credential into the browser.

Set `BREEZE_GUIDE_TOOLS_DIR` to your owned Playwright installation and
`PLAYWRIGHT_BROWSERS_PATH` to its browser/FFmpeg cache when using a custom installation.
The recording process requires the FFmpeg revision associated with that Playwright
version. The browser executable can be selected with `BREEZE_CHROME_PATH`.

```sh
node --env-file=/path/to/approved.env e2e/demos/run.mjs /absolute/new/evidence-directory
```

Add `--full` to run all existing ordinary scenarios and labelled fault injections, while
recording only the selected demonstrations. The original goals, application fixtures,
approval fixtures and independent graders are reused. No scenario is retried by this
recording wrapper. Each attempt remains in its own evidence directory.

The recordings show search and filtering, account changes, an already-correct no-op,
form filling and review across document navigation, explicit test approval and resume,
a refused unapproved purchase, cancellation, and a labelled context-destruction fault.
All stores and account applications are local fixtures; checkout creates fake orders
and never charges a real payment method. Fixture approval is a test input, not user
approval to operate on a real account.

Videos mask contact and payment input text and the shipping A review's email and phone
values. This changes presentation only; values, observations and graders remain intact.
Raw WebM recordings and a numeric event timeline are stored under `videos/`. Keep media
outside Git. Edited versions should state their playback speed and link to the raw run
and grader result; do not present edited duration as model latency.

The campaign uses caller floors 0.2 action, 0.3 argument, 0.5 commitment and 0.4 completion.
These do not change library defaults or establish provider calibration. Optional
explicit-question and conjunction experiments are not enabled.

`public.mjs` runs bounded tasks on Wikipedia, Selenium's official web form, and
the public React TodoMVC demo. Use `--case=<id>` to select one case. It keeps the
unadapted TodoMVC attempt separate from `todomvc-visible-controls`, whose caller-owned
adapter exposes the transparent native checkboxes and provides labels and selected
states from the rendered task titles and filter classes. That adapted case supplies
at most three explicit test approvals, each bound to the requested command and
snapshot. It never approves purchase, deletion, publication or sending effects.

`transport.controls.mjs` proves the independent read changes the document while
preserving a hash URL, uses GET even on a document reached by POST, does not replay
that POST, and refuses mismatched origins, cancellation and foreign redirects.
