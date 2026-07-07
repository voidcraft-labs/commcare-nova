# PR-06: SA tools, MCP, docs I

*Self-contained implementation plan. Reference rationale: `docs/plans/2026-07-06-f1-…` §5.7,
`…f4-…` §3.8/§5, `…f5-…` §5. Scope rulings in `docs/plans/2026-07-06-pr-execution-plan.md`
apply. Depends on PR-01 (vocabulary), PR-02 (table registry), PR-03/04/05 (so the SA's edits
are visible end-to-end before the guidance ships).*

**Goal.** The chat SA and the MCP API can author everything wave 1 built — display
conditions, case operations, lookup tables and their references — with prompt guidance that
teaches *when*, and public docs that describe what shipped. After this PR, "only supervisors
see the admin menu" or "closing a visit also updates the household record" are one chat
message away.

## Verified contracts this PR relies on

- `updateModule` / `updateForm` input schemas are **hand-written Zod** in their tool files
  (`lib/agent/tools/updateModule.ts::updateModuleInputSchema`,
  `…/updateForm.ts::updateFormInputSchema`, both `.strict()`); patches flow
  `updateModuleMutations`/`updateFormMutations` (`lib/agent/blueprintHelpers.ts`) →
  `guardedMutate` (`lib/agent/tools/common.ts`) → `lib/doc/commitVerdicts.ts::mutationCommitVerdict`.
  A rejected batch persists nothing and returns the findings.
- **Clear = `null`, never `undefined`** — a clear must survive the SSE `data-mutations` wire
  and the Firestore event log, both of which drop `undefined` (`lib/doc/CLAUDE.md`
  null-as-delete rule; the patch reducers delete on `null`).
- **Parse/check at the tool boundary, never cast a raw payload into an AST slot** — the
  commit gate passes a raw string through, but the next load's Zod gate rejects it and the
  app stops loading (`lib/agent/CLAUDE.md`). Typed-Predicate params follow the
  `set_case_list_filter` precedent (`lib/agent/tools/case-list-config/setCaseListFilter.ts`:
  `predicateSchema.nullable()`, `null` clears) plus a `checkPredicate` run under the right
  PR-01 context before any mutation is built.
- **MCP propagation is automatic for existing tools**:
  `lib/mcp/adapters/sharedToolAdapter.ts::registerSharedTool` builds the wire schema from the
  tool's own Zod (`{ ...tool.inputSchema.shape, app_id }`). A **brand-new** tool needs one
  `SHARED_TOOLS` entry in `lib/mcp/server.ts` — nothing else.
- `scripts/test-schema.ts` verifies each schema is accepted by the Anthropic API; it already
  imports `updateModuleInputSchema` — `updateForm` and every new tool must be added.
- Prompt guidance lives in `lib/agent/prompts.ts::SHARED_TAIL` (`## Architecture Principles`
  with `###` subsections — `### Field Validation`, `### Hidden Values` are the pattern).
- Public docs are fumadocs MDX under `content/docs/` (nav via `meta.json`); `mcp/tools.mdx`
  is the per-tool reference; **no conceptual authoring section exists yet** — this PR creates
  it.
- The `jr:count` doc correction (owed since the F4 pass): JavaRosa resolves `jr:count`
  **dynamically at navigation** — `commcare-core/.../FormEntryModel::createModelForGroup`
  reads the count node's current value when the model walks to the repeat, and
  `FormDef::canCreateRepeat` re-resolves per check. Nova's `count_bound` is behaviorally
  frozen only because its hoisted `__nova_count_*` node is seeded once at `xforms-ready`.
  `lib/commcare/CLAUDE.md`'s "evaluated ONCE at form load" misstates the mechanism.

## Build

### 1. Display-condition params

`display_condition?: Predicate | null` on `updateModuleInputSchema` and
`updateFormInputSchema`. Boundary: `checkPredicate` under
`displayConditionContext(doc, module, level)` (PR-01) before folding into the patch; on
checker errors return the findings as the tool error (Elm-like, person-to-person). No new
tools; MCP rides automatically.

### 2. Case-operation tools

Four new shared tools mirroring the doc mutations: `add_case_operation`,
`update_case_operation`, `remove_case_operation`, `move_case_operation`. Inputs mirror
PR-01's `CaseOperation` exactly — `action`, `case_type`, `target` (discriminated union incl.
`{kind:"new", id_from?}` / `{kind:"op", op_id}` / `{kind:"session"}` /
`{kind:"expression"}`), `condition`, `for_each`, `name`, `owner`, `rename`, `retype`,
`writes` (with per-write `condition`), `links` (identifier / target_type / target-or-null /
relationship). Ops address by `(moduleIndex, formIndex, opId)`; positional resolution uses
the sorted `resolveModuleUuid`/`resolveFormUuid` helpers (never raw array position — the
order-sweep test enforces this). Each tool prepends the catalog chokepoint mutations
(`declareCaseType` / `ensureCatalogProperty`) exactly as PR-01's surfaces do, and commits
via `guardedMutate`. Register all four in `SHARED_TOOLS`.

### 3. Table tools + field params

Tables are **Project-scoped registry data (PR-02), not doc mutations** — so table tools
write through the registry service with Project-membership auth, not `guardedMutate`:

- `create_lookup_table` / `update_lookup_table` / `delete_lookup_table` — schema CRUD
  (tag, name, columns) against the PR-02 registry; deletion blocked with a person-readable
  reference list when any app in the Project references the table.
- `set_lookup_table_rows` — bulk row replace (ordered), with an explicit payload cap
  (reject over-cap with a message naming the cap and the CSV-import alternative in the
  builder). Row writes validate against column types (PR-02's AJV path).
- `options_source` on the two select kinds enters the **generated** field-tool arms (the
  kinds-registry-driven schema in `lib/agent/toolSchemaGenerator.ts` picks up the new slot;
  verify the generated arm round-trips through `generate_schema`). `table-lookup` /
  `table-ref` values ride the existing expression params once PR-01's parser accepts them.

New tools get `SHARED_TOOLS` entries (`requires: "edit"`); reads (`list_lookup_tables`,
`get_lookup_table`) get `requires: "view"`.

### 4. Schema test coverage

Add to `scripts/test-schema.ts`: `updateForm` (missing today), the four op tools, the table
tools. Run `npx tsx scripts/test-schema.ts` and record the pass in the PR description.

### 5. Prompt guidance (`prompts.ts::SHARED_TAIL`)

Three new `###` subsections under `## Architecture Principles`, each ≤ ~25 lines, written as
trigger smells + negative guidance (the house style):

- **Display conditions** — smells: role-gated menus ("only supervisors approve…"),
  workflow-stage forms ("only show follow-up once intake is done" via case counts),
  screen-width layouts, date windows. Negative: per-question branching is field `relevant`,
  not a display condition; never hide the only path to required data; user-data conditions
  assume the project provisions matching user fields (export note until wave 2's user
  types land).
- **Case operations** — smells: "when X happens, also update/mark/recalculate Y" (fan-out —
  and the tile ruling's corollary: *project parent fields with calculated columns, don't
  copy them*); "remove/archive items from a list the form iterates" (close-by-id — with the
  soft-close doctrine: primary entities get a status property, hard close is for
  finished-as-data records, and case search excludes closed cases); "one event, several
  records" (event forms); "merge/re-link/unlink records" (link surgery); audit-trail
  records. Negative: the session case's own lifecycle stays on ordinary form types; ops
  never compensate for missing selection structure; no ownership/routing/notification
  promises — that vocabulary arrives in wave 2.
- **Lookup tables** — the three verified patterns: select options at scale (10+ options, or
  reused across forms → a table, not inline options), address-book style lookups in
  expressions, friendly-id source data. Restore-size doctrine: tables ship to every device —
  keep them reference-sized. When NOT to reach for a table: a tiny per-column value→label
  display map is still an id-mapping column.

### 6. Public docs

- New authoring section under `content/docs/` (+ `meta.json`): one page each for display
  conditions (incl. the persona-preview explainer), case operations (intent-level verbs; the
  CommCare "Advanced Case Actions" name only as export detail), lookup tables (incl. the
  two delivery paths and the keep-tables-small doctrine). Write behaviors as what the user
  sees in the builder/preview and in Web Apps — never parser internals.
- `content/docs/mcp/tools.mdx`: rows for every new/changed tool.

### 7. CLAUDE.md sync

`lib/domain` (new vocabulary map lines), `lib/commcare` (menu relevancy + op-block + itemset
emission notes; **the `jr:count` mechanism correction** with the two citations above —
keep Nova's behavioral note, fix the JavaRosa claim), `lib/case-store` (lookup rows +
registry), `components/builder` (new workspaces/sections), `lib/agent` (new tool families).

### 8. Drift sweep

The standing pre-commit sweep: stale comments, v1-punt language, narrow rationales, path
drift across everything this wave touched.

## Tests / acceptance

- Tool-level tests: display-condition set/clear round-trip incl. `null`; op tool → mutation
  → gate rejection surfaces findings; table tool auth (non-member rejected), payload cap,
  reference-blocked deletion.
- `scripts/test-schema.ts` passes with every new schema.
- MCP: dispatch-level test that one op tool and one table tool execute over
  `app/api/mcp` (the existing dispatch test pattern).
- Docs build (`npm run typecheck` covers fumadocs-mdx); `lint`/`test` clean.
- Acceptance: in a dev chat, one message each produces — a gated module, a form with a
  fan-out update op, a table-backed select — and the same operations succeed over MCP.

## Non-goals

Wave-2 vocabulary and guidance (users/org/automations — PR-12); provisioning; the
ownership mental model in prompts (explicitly held back until wave 2); any emitter/preview
changes.

## Open choices (implementer)

- Whether `create_module`/`create_form` also accept `display_condition` at creation
  (recommend no — update tools suffice; note for a fast follow).
- Whether op tools take one `operation` object or flattened params (recommend the object —
  it mirrors the schema and keeps `test-schema.ts` meaningful).
