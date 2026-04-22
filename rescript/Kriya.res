// ReScript bindings for @juspay/kriya
// Source-only: consumers' rescript compiler picks these up via bs-dependencies.
// Types mirror src/types/*.ts — keep in sync when the TS API changes.

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

type actionType =
  | @as("navigate") Navigate
  | @as("click") Click
  | @as("fill") Fill
  | @as("fillForm") FillForm
  | @as("submitForm") SubmitForm
  | @as("screenshot") Screenshot
  | @as("wait") Wait
  | @as("press") Press

// Open bag of string parameters. kriya's ActionCommand.parameters is
// `Record<string, string>`; this record lists the keys commonly read by
// action executors. Missing fields are elided at runtime (undefined).
type actionParameters = {
  url?: string, // navigate
  selector?: string, // click, fill, wait, press
  description?: string, // click, fill, press, (any)
  value?: string, // fill
  key?: string, // press
  duration?: string, // wait
  condition?: string, // wait (visible | hidden | enabled | disabled)
  formId?: string, // submitForm, fillForm
  fields?: string, // fillForm — JSON-stringified field map
  reason?: string, // diagnostic
}

type actionCommand = {
  @as("type") type_: actionType,
  parameters: actionParameters,
  timeout?: int,
  description?: string,
}

// ---------------------------------------------------------------------------
// Execution result
// ---------------------------------------------------------------------------

type executionStatus =
  | @as("pending") Pending
  | @as("in_progress") InProgress
  | @as("completed") Completed
  | @as("failed") Failed

type errorCode =
  | @as("INVALID_ACTION") InvalidAction
  | @as("ELEMENT_NOT_FOUND") ElementNotFound
  | @as("FORM_NOT_REGISTERED") FormNotRegistered
  | @as("FORM_NOT_FOUND") FormNotFound
  | @as("FIELD_NOT_FOUND") FieldNotFound
  | @as("EXECUTION_TIMEOUT") ExecutionTimeout
  | @as("EXECUTION_FAILED") ExecutionFailed
  | @as("NETWORK_ERROR") NetworkError
  | @as("PERMISSION_DENIED") PermissionDenied
  | @as("INVALID_CONFIGURATION") InvalidConfiguration
  | @as("SCREENSHOT_FAILED") ScreenshotFailed
  | @as("VALIDATION_FAILED") ValidationFailed
  | @as("BROWSER_NOT_SUPPORTED") BrowserNotSupported

type executionResult = {
  success: bool,
  status: executionStatus,
  data?: JSON.t,
  error?: string,
  errorCode?: errorCode,
  timestamp: float,
}

// ---------------------------------------------------------------------------
// Engine config
// ---------------------------------------------------------------------------

// All fields optional — passed as Partial<AutomationConfig> to the factory.
type automationConfig = {
  timeout?: int,
  retryAttempts?: int,
  screenshotOnError?: bool,
  debugMode?: bool,
  formDetectionEnabled?: bool,
  contextCaptureEnabled?: bool,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

type eventType =
  | @as("form_registered") FormRegistered
  | @as("form_unregistered") FormUnregistered
  | @as("form_filled") FormFilled
  | @as("form_submitted") FormSubmitted
  | @as("action_started") ActionStarted
  | @as("action_completed") ActionCompleted
  | @as("action_failed") ActionFailed
  | @as("context_captured") ContextCaptured
  | @as("screenshot_taken") ScreenshotTaken

type automationEvent = {
  @as("type") type_: eventType,
  timestamp: float,
  data?: Dict.t<JSON.t>,
}

type eventCallback = automationEvent => unit

// ---------------------------------------------------------------------------
// Action option records (typed mirrors of ClickOptions, FillOptions, …)
// ---------------------------------------------------------------------------

type clickButton = | @as("left") Left | @as("right") Right | @as("middle") Middle

type clickPosition = {x: int, y: int}

type clickOptions = {
  selector?: string,
  description?: string,
  position?: clickPosition,
  button: clickButton,
  clickCount: int,
}

type fillOptions = {
  selector?: string,
  description?: string,
  value: string,
  clearFirst: bool,
  triggerEvents: bool,
}

type waitCondition =
  | @as("visible") Visible
  | @as("hidden") Hidden
  | @as("enabled") Enabled
  | @as("disabled") Disabled

type waitOptions = {
  duration?: int,
  selector?: string,
  condition?: waitCondition,
  timeout?: int,
}

type pressOptions = {
  key: string,
  selector?: string,
  description?: string,
}

type navigationOptions = {
  url: string,
  waitForLoad: bool,
  timeout?: int,
}

// ---------------------------------------------------------------------------
// Context / page / forms
// ---------------------------------------------------------------------------

type viewportInfo = {
  width: int,
  height: int,
  scrollX: float,
  scrollY: float,
}

type clipRegion = {x: int, y: int, width: int, height: int}

type screenshotFormat =
  | @as("png") Png
  | @as("jpeg") Jpeg
  | @as("webp") Webp

type screenshotOptions = {
  fullPage: bool,
  quality: float,
  format: screenshotFormat,
  clip?: clipRegion,
}

type elementContext = {
  tagName: string,
  id?: string,
  className?: string,
  textContent?: string,
  @as("type") type_?: string,
  value?: string,
  href?: string,
  clickable: bool,
  visible: bool,
}

type formFieldValueType =
  | @as("string") String
  | @as("number") Number
  | @as("boolean") Boolean
  | @as("array") Array
  | @as("file") File

// `value` here is `string | number | boolean | readonly string[] | File` in TS.
// JSON.t is the lowest common denominator that keeps consumers unblocked;
// narrow at the callsite via JSON classification.
type formFieldValue = {
  @as("type") type_: formFieldValueType,
  value: JSON.t,
}

type formFieldContext = {
  name: string,
  @as("type") type_: string,
  value: formFieldValue,
  initialValue: formFieldValue,
  placeholder?: string,
  required: bool,
  disabled: bool,
  label?: string,
}

type formContext = {
  formId: string,
  action?: string,
  method: string,
  fields: array<formFieldContext>,
  isRegistered: bool,
  hasSubmitButton: bool,
}

type pageContext = {
  pageUrl: string,
  title: string,
  timestamp: float,
  totalFormsFound: int,
  forms: array<formContext>,
  elements: array<elementContext>,
  viewport: viewportInfo,
}

// ---------------------------------------------------------------------------
// FormLibrary (opaque — consumers typically won't construct one)
// ---------------------------------------------------------------------------

type formLibrary

// ---------------------------------------------------------------------------
// Engine (abstract + @send externals — handles optional args cleanly)
// ---------------------------------------------------------------------------

type engine

@send external engineInitialize: engine => unit = "initialize"
@send external engineInitializeWith: (engine, formLibrary) => unit = "initialize"

@send
external engineExecuteAction: (engine, actionCommand) => promise<executionResult> = "executeAction"

@send
external engineExecuteActions: (engine, array<actionCommand>) => promise<array<executionResult>> =
  "executeActions"

@send
external engineCapturePageContext: engine => promise<pageContext> = "capturePageContext"

@send external engineRegisterForm: (engine, string, Dom.element) => unit = "registerForm"
@send external engineUnregisterForm: (engine, string) => unit = "unregisterForm"

@send
external engineAddEventListener: (engine, eventType, eventCallback) => unit = "addEventListener"
@send
external engineRemoveEventListener: (engine, eventType, eventCallback) => unit =
  "removeEventListener"

@send external engineCaptureScreenshot: engine => promise<string> = "captureScreenshot"
@send
external engineCaptureScreenshotWith: (engine, screenshotOptions) => promise<string> =
  "captureScreenshot"

@send external engineIsInitialized: engine => bool = "isInitialized"
@send external engineDispose: engine => unit = "dispose"

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

@module("@juspay/kriya")
external createAutomationEngine: automationConfig => engine = "createAutomationEngine"

// Default config as re-exported by the JS package.
@module("@juspay/kriya")
external defaultConfig: automationConfig = "DEFAULT_CONFIG"

// ---------------------------------------------------------------------------
// Ergonomic helpers
// ---------------------------------------------------------------------------

// Create an engine with labeled, optional args. Matches kriya's real config
// surface — no `headless`/`viewport` (kriya runs in the consumer's browser).
let createEngine = (
  ~timeout: option<int>=?,
  ~retryAttempts: option<int>=?,
  ~screenshotOnError: option<bool>=?,
  ~debugMode: option<bool>=?,
  ~formDetectionEnabled: option<bool>=?,
  ~contextCaptureEnabled: option<bool>=?,
): engine => {
  let config: automationConfig = {
    ?timeout,
    ?retryAttempts,
    ?screenshotOnError,
    ?debugMode,
    ?formDetectionEnabled,
    ?contextCaptureEnabled,
  }
  createAutomationEngine(config)
}

// --- Engine method wrappers (record-style, so call sites read nicely) ------

let initialize = (engine: engine): unit => engineInitialize(engine)

let executeAction = (engine: engine, action: actionCommand): promise<executionResult> =>
  engineExecuteAction(engine, action)

let executeActions = (engine: engine, actions: array<actionCommand>): promise<
  array<executionResult>,
> => engineExecuteActions(engine, actions)

let capturePageContext = (engine: engine): promise<pageContext> => engineCapturePageContext(engine)

let registerForm = (engine: engine, formId: string, formElement: Dom.element): unit =>
  engineRegisterForm(engine, formId, formElement)

let unregisterForm = (engine: engine, formId: string): unit =>
  engineUnregisterForm(engine, formId)

let addEventListener = (engine: engine, eventType: eventType, cb: eventCallback): unit =>
  engineAddEventListener(engine, eventType, cb)

let removeEventListener = (engine: engine, eventType: eventType, cb: eventCallback): unit =>
  engineRemoveEventListener(engine, eventType, cb)

let captureScreenshot = (
  engine: engine,
  ~options: option<screenshotOptions>=?,
): promise<string> =>
  switch options {
  | Some(opts) => engineCaptureScreenshotWith(engine, opts)
  | None => engineCaptureScreenshot(engine)
  }

let isInitialized = (engine: engine): bool => engineIsInitialized(engine)

let disposeEngine = (engine: engine): unit => engineDispose(engine)

// --- Action builders --------------------------------------------------------

let navigate = (~url: string, ~timeout: option<int>=?): actionCommand => {
  type_: Navigate,
  parameters: {url: url},
  ?timeout,
}

let click = (
  ~selector: option<string>=?,
  ~description: option<string>=?,
  ~timeout: option<int>=?,
): actionCommand => {
  type_: Click,
  parameters: {?selector, ?description},
  ?timeout,
}

let fill = (
  ~selector: string,
  ~value: string,
  ~description: option<string>=?,
  ~timeout: option<int>=?,
): actionCommand => {
  type_: Fill,
  parameters: {selector: selector, value: value, ?description},
  ?timeout,
}

let wait = (
  ~duration: option<int>=?,
  ~selector: option<string>=?,
  ~condition: option<waitCondition>=?,
  ~timeout: option<int>=?,
): actionCommand => {
  let durationStr = duration->Option.map(d => Int.toString(d))
  let conditionStr = condition->Option.map(c =>
    switch c {
    | Visible => "visible"
    | Hidden => "hidden"
    | Enabled => "enabled"
    | Disabled => "disabled"
    }
  )
  let parameters: actionParameters = {
    ?selector,
    duration: ?durationStr,
    condition: ?conditionStr,
  }
  {
    type_: Wait,
    parameters,
    ?timeout,
  }
}

let press = (
  ~key: string,
  ~selector: option<string>=?,
  ~description: option<string>=?,
  ~timeout: option<int>=?,
): actionCommand => {
  type_: Press,
  parameters: {key: key, ?selector, ?description},
  ?timeout,
}

let screenshot = (~timeout: option<int>=?): actionCommand => {
  type_: Screenshot,
  parameters: {},
  ?timeout,
}

let submitForm = (
  ~formId: option<string>=?,
  ~timeout: option<int>=?,
): actionCommand => {
  type_: SubmitForm,
  parameters: {?formId},
  ?timeout,
}

// Build a `fillForm` action. `fields` is a dict of fieldName -> string value,
// serialized into a single JSON string because kriya's ActionCommand.parameters
// is Record<string, string> — the whole field map travels as one `fields` param.
let fillForm = (
  ~formId: option<string>=?,
  ~fields: Dict.t<string>,
  ~timeout: option<int>=?,
): actionCommand => {
  let fieldsJson =
    fields
    ->Dict.toArray
    ->Array.map(((k, v)) => (k, JSON.Encode.string(v)))
    ->Dict.fromArray
    ->JSON.Encode.object
    ->JSON.stringify
  {
    type_: FillForm,
    parameters: {fields: fieldsJson, ?formId},
    ?timeout,
  }
}

// Fill + execute in one call. Matches the old helper shape callers had.
let executeFormFill = (
  engine: engine,
  ~formId: option<string>=?,
  ~fields: Dict.t<string>,
): promise<executionResult> =>
  executeAction(engine, fillForm(~formId?, ~fields))
