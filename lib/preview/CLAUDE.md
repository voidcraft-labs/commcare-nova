# Web Preview Engine

Client-side form preview running entirely from `AppBlueprint` — no XForm parsing, no server calls.

## Three Subsystems

**1. XPath Evaluator** (`xpath/`) — Reuses the Lezer parser from `lib/codemirror/xpath-parser.ts`. Walks CST to evaluate paths, arithmetic, comparisons, logical ops, function calls, and hashtag refs. Function registry in `functions.ts` (~35 functions).

**2. Form Engine** (`engine/`) — Reactive state machine. Initializes from `BlueprintForm` + `CaseType` metadata. Maintains `DataInstance` (values by path), builds `TriggerDag` from XPath expressions, cascades recalculation on every value change. Exposes `subscribe` + `getSnapshot` for `useSyncExternalStore`.

**3. Preview UI** (`components/preview/`) — Navigation shell: Home → Module → (Case List →) Form Entry. Cyan accent theme (`.preview-theme` in globals.css).

## XPath Evaluator — Lezer Grammar Gotcha

The grammar produces **two distinct `Child` node types** (one from `rootStep`, one from `expr`) and two `Descendant` types. `one('Child')` only finds the first. The evaluator and dependency extractor use `many('Child')` to create `Set` collections and check with `.has()` — same pattern the formatter uses for `Keywords`.

## Form Engine Lifecycle

**On init**: merge data model defaults → build DataInstance → preload case data (followup) → build TriggerDag → init QuestionStates → apply `default_value` (one-time, overrides preloaded case data) → full cascade.

**On `setValue(path)`**: update instance → DAG cascade (topologically sorted) → re-evaluate expressions per affected path (calculate, relevant, required, validation) → re-validate.

**On `touch(path)` (blur)**: mark touched → validate validation rule only. Required is intentionally deferred to submit — showing "required" on blur is bad UX (user clicks in, navigates away, gets immediate error before they've filled anything). The red asterisk communicates requiredness until submission.

**On `validateAll()` (submit)**: mark all visible fields touched → validate each (required + validation) → return boolean. `FormScreen` scrolls to first error on failure.

**On `reset()`**: full reinitialization — rebuild DataInstance, re-preload case data (followup), reinit all QuestionStates, reapply `default_value` expressions, full cascade. Returns the form to its exact initial state. Called by the reset button in FormScreen's header.

**On `resetValidation()`**: clear touched state and errors on all fields. Called by `FormScreen` when leaving test mode so fields start clean on re-entry.

**Validation display**: errors show only when `state.touched && !state.valid`. Fields start untouched — no error spam on load. In edit mode (preview), `FormRenderer` passes a clean `displayState` (empty value, untouched, valid) to field components — inputs appear empty with no errors. Engine state is preserved internally. **Relevant conditions are bypassed in edit mode** — `SortableQuestion` skips the `!state.visible` check so all questions remain visible for editing, even when their relevant XPath evaluates to false (which it would since there are no real values).

**Value persistence**: `useFormEngine` snapshots live-mode values (via `getValueSnapshot()`) into a ref before engine recreation (caused by `mutationCount` bumps from preview edits). New engines restore values via `restoreValues()`, which restores only user-touched values, runs a full cascade, then re-validates touched fields. Untouched fields keep the new engine's defaults — this ensures editing a `default_value` expression in design mode is immediately reflected in preview.

**Unresolved case refs**: When a followup form has no case data, `resolveHashtag` returns empty string for `#case/` refs (not a placeholder string). `QuestionState.caseRef` is set from `question.case_property` for these fields. Output tag resolution returns `{ text, className }` objects via `ResolvedOutput` type, producing styled `<span class="case-ref">` elements in labels. The `.case-ref` CSS class (globals.css) renders a cyan monospace badge.

## Navigation Flow (matches CommCare)

```
Home (module cards)
  → Module (form list)
    → Registration/Survey → Form opens directly
    → Followup → Case list ("Select a case") → Form with case data
```

Case list is a gate for a specific followup form, not a module-level screen. Selected row passes `caseId` to the form screen via the nav stack. Breadcrumbs for follow-up forms show the selected case name (looked up by `caseId` via `getCaseData()`).

## Case Data Resolution

The nav stack only carries `caseId` — case data is resolved at the point of use, not stored in navigation state. `FormScreen` looks up case data by `caseId` via `getCaseData()` and passes the resulting `Map<string, string>` to `FormEngine`. Breadcrumbs similarly look up case names by `caseId`. This separation means swapping the data source (dummy → real API) only requires changing the lookup functions in `dummyData.ts`.

Dummy case data is generated once per case type and cached at the module level in `dummyData.ts`. `getDummyCases()` returns all rows (used by `CaseListScreen`); `getCaseData(caseTypeName, caseId)` returns a single case's properties by ID (used by `FormScreen` and breadcrumbs).

## Key Files

- `xpath/dependencies.ts` — extracts `/data/...` path refs from XPath for DAG construction
- `xpath/rewrite.ts` — Lezer-based XPath rewriting for rename propagation
- `engine/dataInstance.ts` — flat `Map<path, value>` with repeat group support
- `engine/triggerDag.ts` — dependency graph + topological cascade ordering. `reportCycles(questions)` returns cycle paths for validation (used by deep validator); `detectAndBreakCycles()` silently breaks them for preview
- `engine/outputTag.ts` — parse/resolve/rewrite `<output value="..."/>` tags via htmlparser2
- `engine/dummyData.ts` — generates and caches realistic placeholder case rows from CaseType. `getDummyCases()` returns all rows; `getCaseData(caseTypeName, caseId)` looks up a single case by ID
