# Web Preview Engine

Client-side form preview running entirely from `AppBlueprint` — no XForm parsing, no server calls.

## Three Subsystems

**1. XPath Evaluator** (`xpath/`) — Reuses the Lezer parser from `lib/codemirror/xpath-parser.ts`. Walks CST to evaluate paths, arithmetic, comparisons, logical ops, function calls, and hashtag refs. Function registry in `functions.ts` (~35 functions).

**2. Form Engine** (`engine/`) — Reactive state machine. Initializes from `BlueprintForm` + `CaseType` metadata. Maintains `DataInstance` (values by path), builds `TriggerDag` from XPath expressions, cascades recalculation on every value change. Exposes `subscribe` + `getSnapshot` for `useSyncExternalStore`.

**3. Preview UI** (`components/preview/`) — Navigation shell: Home → Module → (Case List →) Form Entry. Cyan accent theme (`.preview-theme` in globals.css).

## XPath Evaluator — Lezer Grammar Gotcha

The grammar produces **two distinct `Child` node types** (one from `rootStep`, one from `expr`) and two `Descendant` types. `one('Child')` only finds the first. The evaluator and dependency extractor use `many('Child')` to create `Set` collections and check with `.has()` — same pattern the formatter uses for `Keywords`.

## Form Engine Lifecycle

**On init**: merge data model defaults → build DataInstance → preload case data (followup) → build TriggerDag → init QuestionStates → apply `default_value` (one-time) → full cascade.

**On `setValue(path)`**: update instance → DAG cascade (topologically sorted) → re-evaluate expressions per affected path (calculate, relevant, required, constraint) → re-validate constraint.

**On `touch(path)` (blur)**: mark touched → validate constraint only. Required validation is deferred to submit to avoid error flash on mode switches.

**On `validateAll()` (submit)**: mark all visible fields touched → validate each (required + constraint) → return boolean. `FormScreen` scrolls to first error on failure.

**On `reset()`**: full reinitialization — rebuild DataInstance, re-preload case data (followup), reinit all QuestionStates, reapply `default_value` expressions, full cascade. Returns the form to its exact initial state. Called by the reset button in FormScreen's header.

**On `resetValidation()`**: clear touched state and errors on all fields. Called by `FormScreen` when leaving test mode so fields start clean on re-entry.

**Validation display**: errors show only when `state.touched && !state.valid`. Fields start untouched — no error spam on load. In edit mode (preview), `FormRenderer` passes a clean `displayState` (empty value, untouched, valid) to field components — inputs appear empty with no errors. Engine state is preserved internally.

**Value persistence**: `useFormEngine` snapshots live-mode values (via `getValueSnapshot()`) into a ref before engine recreation (caused by `mutationCount` bumps from preview edits). New engines restore values via `restoreValues()`, which sets values, runs a full cascade, then re-validates touched fields. This lets users edit form structure in preview without losing their test data.

**Unresolved case refs**: When a followup form has no case data, `resolveHashtag` returns empty string for `#case/` refs (not a placeholder string). `QuestionState.caseRef` is set from `question.case_property` for these fields. Output tag resolution returns `{ text, className }` objects via `ResolvedOutput` type, producing styled `<span class="case-ref">` elements in labels. The `.case-ref` CSS class (globals.css) renders a cyan monospace badge.

## Navigation Flow (matches CommCare)

```
Home (module cards)
  → Module (form list)
    → Registration/Survey → Form opens directly
    → Followup → Case list ("Select a case") → Form with case data
```

Case list is a gate for a specific followup form, not a module-level screen. Selected row passes properties as `caseData` to `FormEngine`. Breadcrumbs for follow-up forms show the selected case name (from `caseData.get('case_name')`) instead of repeating the form name.

## Case Data Resolution

`usePreviewNav` auto-resolves case data for every screen entering the nav stack via `resolveScreen()`. Follow-up form screens without explicit `caseData` get auto-generated dummy data; screens with existing caseData (from CaseList user selection) are preserved. This is the **single place** to change when real case data is implemented.

## Key Files

- `xpath/dependencies.ts` — extracts `/data/...` path refs from XPath for DAG construction
- `xpath/rewrite.ts` — Lezer-based XPath rewriting for rename propagation
- `engine/dataInstance.ts` — flat `Map<path, value>` with repeat group support
- `engine/triggerDag.ts` — dependency graph + topological cascade ordering
- `engine/outputTag.ts` — parse/resolve/rewrite `<output value="..."/>` tags via htmlparser2
- `engine/dummyData.ts` — generates realistic placeholder case rows from CaseType
- `engine/resolveScreen.ts` — auto-attaches dummy case data to follow-up form screens
