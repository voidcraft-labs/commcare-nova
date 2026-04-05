# Web Preview Engine

Client-side form preview running entirely from `AppBlueprint` — no XForm parsing, no server calls. Three subsystems: XPath evaluator (`xpath/`), form engine (`engine/`), preview UI (`components/preview/`).

## XPath Evaluator — First-Class Date Type

`XPathValue = string | number | boolean | XPathDate`. Dates are not strings — `today()` returns an `XPathDate` (days since epoch internally, ISO string on coercion). This makes `today() + 1` produce an XPathDate representing tomorrow, not `NaN`. CommCare's runtime doesn't do this (it returns a raw day-number), so `lib/transpiler/` wraps date-producing arithmetic in `date()` at export time.

Always use `xpathToString(result)` to stringify XPath results, never `String(result)` — `String(XPathDate)` gives `[object Object]`.

## XPath Evaluator — Two `Child` Node Types

The Lezer grammar produces **two distinct `Child` node types** (one from `rootStep`, one from `expr`) and two `Descendant` types. `one('Child')` only finds the first. The evaluator and dependency extractor use `many('Child')` to create `Set` collections and check with `.has()` — same pattern the formatter uses for `Keywords`.

## Form Engine Lifecycle

**On init:** build DataInstance → preload case data (followup forms) → build TriggerDag → init QuestionStates → apply `default_value` (one-time, overrides preloaded case data) → full cascade. Questions are self-contained — no merge from `case_types` at runtime.

**On `setValue(path)`:** update instance → DAG cascade (topologically sorted) → re-evaluate expressions for affected paths (calculate, relevant, required, validation) → re-validate.

**On `touch(path)` (blur):** mark touched → validate validation rule only. Required is intentionally deferred to submit — showing "required" on blur is bad UX because the user may have clicked into a field and navigated away before filling anything. The red asterisk communicates requiredness until submission.

**On `validateAll()` (submit):** mark all visible fields touched → validate each (required + validation) → return boolean.

**On `reset()`:** full reinitialization — rebuild DataInstance, re-preload case data, reinit all QuestionStates, reapply defaults, full cascade. Returns to exact initial state.

**On `resetValidation()`:** clear touched state and errors on all fields. Called when leaving test mode so fields start clean on re-entry.

## Value Persistence Across Engine Recreation

Blueprint mutations in design mode (incrementing `mutationCount`) recreate the engine. `useFormEngine` snapshots live-mode values before recreation and restores **only user-touched values** via `restoreValues()`. Untouched fields pick up the new engine's defaults — this ensures that editing a `default_value` expression in design mode is immediately reflected in preview.

## Case Data Resolution

The nav stack carries only `caseId` — case data is resolved at the point of use, not stored in navigation state. `FormScreen` looks up case data by `caseId` via `getCaseData()`. This separation means swapping the data source (dummy → real API) only requires changing the lookup functions in `dummyData.ts`.
