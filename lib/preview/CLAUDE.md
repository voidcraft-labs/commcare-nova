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

### Two-state JSONB collapse for form completion

`computeSubmissionMutation` reads each leaf field's value via
`instance.get(fieldPath)` and filters on emptiness only
(`if (raw === undefined || raw === "") continue`); empty fields
are excluded from the emitted mutation, hidden fields with non-
empty values are NOT excluded. Properties whose value is empty
do not appear as keys in the mutation's `properties` object,
which means the case-store write omits them from the JSONB
document.

AJV's strict-mode constraints rule out the alternatives: `null`
fails `integer` / `number` types; `""` fails `format: date` /
`format: time` / `format: date-time` / the geopoint pattern.
Omission is the only shape that passes validation AND aligns
with Postgres-strict `is-null` semantics ("absent" ≡ "not
present in the JSONB document").

Form completion produces only 2 of the 3 spec-defined JSONB
states (absent / null / present-and-empty) — the
"present-and-empty" state is unreachable via any form completion
path. Other write paths (sample-data generator, direct API
writes) can still produce it. Consumers of `is-blank` should
read `lib/domain/predicate/CLAUDE.md` § "Null vs blank semantics
— locked invariant".

## Repeat-count reactivity

In render paths, read repeat instance counts from `state.repeatCount` (via `useEngineState`), not from `controller.getRepeatCount(uuid)`. The latter is a non-reactive method call — the row only re-renders if it subscribes to something whose reference changed. `addRepeat` / `removeRepeat` bump `repeatCount` on the repeat's own `FieldState` precisely to give subscribers that signal; the new `[N]/...` child writes don't reach the runtime store because `pathToUuid` only registers the `[0]` template path. `getRepeatCount` is fine outside render or in render paths whose lifecycle guarantees no add/remove can happen while mounted (e.g. edit-mode-only rows).

## Value persistence across engine recreation

Blueprint mutations in edit mode recreate the engine. The engine hook snapshots live-mode values before recreation and restores **only user-touched values**. Untouched fields pick up the new engine's defaults — this is what makes editing a `default_value` expression in edit mode immediately visible in preview.

## Case data resolution

The nav stack carries only `caseId`. Case data is looked up by id at the point of use, not stored in navigation state. Swapping the data source (dummy → real API) only requires changing the lookup functions.
