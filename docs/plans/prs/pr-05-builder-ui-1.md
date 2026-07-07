# PR-05: Builder UI I — display conditions, case operations, tables

*Self-contained implementation plan. Reference rationale: `docs/plans/2026-07-06-f1-…` §5.6,
`…f4-…` §5 (builder UI), `…f5-…` §5. Depends on PR-01 (vocabulary + contexts + mutations),
PR-02 (table registry + rows actions), PR-03 (emission — for compile-verified fixtures in
smoke flows), PR-04 (evaluator + persona editor + hidden-items reveal, which are preview-shell
surfaces and NOT re-implemented here). Scope rulings in
`docs/plans/2026-07-06-pr-execution-plan.md` apply.*

**Goal.** The three wave-1 authoring surfaces: display-condition editing on modules and forms,
a Case Operations workspace on forms, and the Tables workspace + table-backed select options.
Everything valid-by-construction (pickers offer only what the checker accepts), everything
dispatched through the gated mutation path. Load the **frontend-design skill** before building;
compose from `@/components/shadcn` (base-nova) and existing builder primitives — never raw
Base UI; icons via `@iconify/react/offline` (Tabler).

## What the user sees

- A **Display condition** section in a module's settings panel and a form's settings panel:
  a sentence-style condition builder ("show when `can_admin` is `yes`", "show when there are
  open `referral` cases"). Conditioned modules/forms carry a small badge on the canvas.
- A **Case operations** workspace on a form: a list of cards, each reading like a sentence —
  "Create a `referral` linked to this client, owned by …", "Close the `commcare-case-claim`
  from field `claim_id`" — with writes, links, conditions, and per-repeat execution visible
  in one place. This is the "what does submitting this form do to the case universe" view.
- A **Tables** workspace: column schema on the left, an editable rows grid on the right, CSV
  paste/import, and a banner marking the table as shared across the Project's apps.
- On single/multi-select fields: a **choices source** switch — inline options (today's editor)
  or "from a lookup table" with table/value/label pickers and an optional filter.

## Existing primitives to build from (verified surfaces)

- Settings panels are `w-80` popovers from gear buttons that **compose sections**:
  `components/builder/detail/moduleSettings/ModuleSettingsPanel.tsx` (currently
  `ModuleCaseTypeSection` + `ModuleAppearanceSection`; its own comment says the shell is
  shaped to compose more) and `…/formSettings/FormSettingsPanel.tsx` (four self-gating
  sections in fixed order — `CloseConditionSection` gates on form type, `ConnectSection` on
  app connectType). New sections drop in as siblings.
- `components/builder/shared/PredicateCardEditor.tsx` is the structural Predicate editor
  (props: `value/onChange/caseTypes/currentCaseType/knownInputs/onValidityChange`); its
  pickers derive from the checker's slot constraints — the PR-01 contexts flow through the
  same mechanism, so **disable-with-reason, never dim** and never offer an arm the context
  rejects. `case-list-config/inspector/FilterInspectorBody.tsx` (+ its live `MatchCount`
  via a server action) is the mounting pattern to clone.
- Field-level XPath slots edit through `components/builder/editor/fields/XPathEditor.tsx`
  (CodeMirror `XPathField` + the `useXPathSlots` text⇄AST bridge + the `CommitOutcome`
  bounce: a gate-rejected commit keeps the editor open with the draft). Field-editor
  sections register per kind in `components/builder/editor/fieldEditorSchemas.ts`.
- Every edit dispatches through `useBlueprintMutations` (the commit gate; `null` clears a
  slot; the `inline` flavor surfaces findings contextually, everything else toasts via
  `notifyRejectedCommit`). Ephemeral UI state goes to `lib/session` or local state — never a
  persisted shadow flag.
- The case-list workspace is the precedent for a **dedicated workspace** surface (vs a
  settings popover); `caseListOnly` modules host their settings in its sticky header.

## Build

### 1. Display-condition sections

- `ModuleDisplayConditionSection` (third section in `ModuleSettingsPanel`) and
  `FormDisplayConditionSection` (in `FormSettingsPanel` beside `CloseConditionSection`):
  mount `PredicateCardEditor` under PR-01's `displayConditionContext` (module vs form
  variant). Empty state: "Always shown — add a condition".
- **Case-first awareness**: the form variant offers selected-case properties only when
  `isCaseFirstModule` holds; otherwise the property picker shows those arms disabled with
  the reason ("this module doesn't guarantee a selected case — every form must load one").
- Commit: `updateModule`/`updateForm` patch with the Predicate (or `null` to clear) through
  `useBlueprintMutations().inline` so `DISPLAY_CONDITION_ALWAYS_FALSE` and type findings
  render inline in the section (the XPathEditor bounce pattern, adapted: editor state stays,
  finding shown under the card).
- **Canvas badges** (edit mode only): a small eye-slash chip on module tiles (home canvas)
  and form tiles carrying a condition; tooltip prints the condition summary (the same
  printer PR-04 uses for the reveal affordance — display-only, one implementation).

### 2. Case Operations workspace

- A dedicated form-level workspace (route/selection via `lib/routing`'s Location model, the
  case-list workspace pattern) — **not** a settings-panel section: ops are content.
- **Op list**: ordered cards (fractional order; drag to reorder → `moveCaseOperation`), add
  menu split by action (Create / Update / Close). Each card is a sentence header +
  expandable body:
  - **Header**: action verb + case type + target summary ("Create `referral` — linked to
    this client", "Update `clinic` from expression…").
  - **Target row** (update/close): Session case (only offered when case-first) / a case
    created above (picker over earlier create ops) / an expression (ValueExpression editor).
    Expression targets carry the **runtime-resolved affordance**: an info chip whose copy
    states the failure semantics plainly — *"Resolved when the form is submitted. If the
    case isn't found, the submission fails with 'Unable to update or close case …' and the
    user's answers are preserved."*
  - **Create extras**: name (required), owner (ValueExpression editor with the PR-01 owner
    vocabulary), **id source** (`idFrom`): default "generated"; optional picker over
    form-local non-repeat fields ("use a field's value as the new case's ID"), with the
    companion hint that other ops/fields can reference this case via `id-of`.
  - **Writes**: rows of catalog property picker + value expression + optional condition;
    the property picker offers the destination type's declared properties and an inline
    "new property…" that routes through the declaration chokepoint.
  - **Rename / re-type facets** (update only): explicit rows, not property writes — the
    pickers make `case_name`/`case_type` unreachable from the writes list (PR-01's
    reserved-name rule).
  - **Links**: rows of identifier (default `parent`) + target type + target (same target
    union, plus "remove link" = null target rendered as an unlink row) + relationship
    (child/extension with one-line explanations of sync behavior).
  - **Condition** (whole-op) and **for each** (repeat picker; copy: "runs once per entry of
    <repeat>").
- All edits emit PR-01's op mutation quartet through the gate; finding presentation inline
  per card.

### 3. Tables workspace + options source

- **Tables workspace** (Project-level surface, reachable from the builder's workspace nav):
  left rail lists the Project's tables (PR-02 registry); main area = schema editor (column
  name/label/type rows; name immutability per PR-02's rules surfaced as locked inputs with
  the reason) + the rows grid (server-action-backed: cell edit, row add/delete/reorder, CSV
  paste and file import mapping columns by header). A persistent banner: *"Shared across
  this Project — changes affect every app that uses this table."* Row edits are data writes
  (no undo; confirm destructive bulk actions).
- **Options source on selects**: a new field-editor section (registered in
  `fieldEditorSchemas.ts` for the two select kinds): a source switch (Inline options ⊕
  Lookup table). Table mode: table picker (registry), value/label column pickers, optional
  filter via `PredicateCardEditor` under the `tableScope` context — including `field`-Term
  choice filters ("only rows where `region` = answer of <field>"), offered via a field
  picker restricted to form-local fields. Switching modes preserves the other mode's config
  in the doc until explicitly cleared (schema exclusivity is enforced at commit; the editor
  guides rather than destroys).

## Tests / acceptance

House testing rules: UI is f(state) — **no RTL/jsdom component tests**; test the state
models (section visibility gating, op card ↔ mutation mapping, options-source exclusivity
transitions) as pure functions; flows ride the Playwright smoke.

Acceptance, phrased as what the user does/sees:
- Open a module's settings → add "show when `can_admin` is `yes`" → the panel shows the
  saved sentence; the module tile gains the badge; preview (PR-04) hides it for a persona
  without the flag.
- In a forms-first module, the form condition editor shows case-property choices disabled
  with the case-first explanation.
- Add a create op with a linked client and an owner expression → the card reads as one
  sentence; reorder ops by drag; reference the created case from a second op's target.
- Set an update op's target to an expression → the runtime-resolved chip shows the
  failure-semantics copy verbatim.
- Create a table, paste CSV rows, wire a select's choices to it with a filter on another
  answer → the preview select updates when that answer changes (PR-04).
- Attempt an always-false condition or a write to `case_name` → inline finding, nothing
  committed.

## Non-goals

The persona editor + hidden-items reveal (PR-04 owns them); emission (PR-03); SA tools +
docs pages (PR-06); tiles UI (PR-07); wave-2 workspaces (PR-12).

## Open choices (implementer)

- Case Operations workspace layout (single column of cards vs master-detail) — pick for
  legibility at 5–20 ops; the 20-op production forms are the stress case.
- Whether the tables workspace lives under the builder shell or a Project-level route
  (recommend builder shell with a Project-scope banner — matches where authors already are).
- CSV import UX details (header mapping, error presentation) — keep v1 minimal
  (paste + file, comma/tab sniffing, per-row error list).
- Badge/chip visuals — frontend-design skill decides; keep the condition-summary printer
  shared with PR-04.
