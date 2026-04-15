# Web Preview Engine

Client-side form preview running entirely from the in-memory blueprint — no XForm parsing, no server calls. Three subsystems: XPath evaluator, form engine, preview UI.

## First-class date type in the XPath evaluator

XPath values include a `XPathDate` alongside string/number/boolean. `today()` returns a date (days-since-epoch internally, ISO string on coercion), so `today() + 1` yields tomorrow, not `NaN`. CommCare's runtime doesn't do this — it returns a raw day-number — so the transpiler wraps date-producing arithmetic in `date()` at export time.

Always use the shared XPath-to-string helper when stringifying results. Native `String()` on a date value gives `[object Object]`.

## Two `Child` / `Descendant` node types in the grammar

The Lezer grammar emits TWO distinct `Child` node types (one from the root-step rule, one from the expression rule) and likewise two `Descendant` types. `one('Child')` only finds the first. The evaluator and dependency extractor use `many('Child')` plus a `Set` / `.has()` check to catch both.

## Form engine lifecycle rules

- **Default values apply one-time on init, AFTER case-data preload** — so the preloaded case data sets the initial state and defaults only fill unset fields.
- **Required validation is deferred to submit.** Showing "required" on blur is bad UX because the user may have clicked in and navigated away. The red asterisk communicates requiredness until submission.
- **`reset()` is a full reinitialization** — rebuild instance, re-preload, reapply defaults, re-cascade. Returns to the exact initial state.
- **`resetValidation()` clears touched state + errors only** — called when leaving test mode so fields start clean on re-entry.

## Value persistence across engine recreation

Blueprint mutations in edit mode recreate the engine. The engine hook snapshots live-mode values before recreation and restores **only user-touched values**. Untouched fields pick up the new engine's defaults — this is what makes editing a `default_value` expression in edit mode immediately visible in preview.

## Case data resolution

The nav stack carries only `caseId`. Case data is looked up by id at the point of use, not stored in navigation state. Swapping the data source (dummy → real API) only requires changing the lookup functions.
