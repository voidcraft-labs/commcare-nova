# PR-06: SA tools, MCP, docs I

> [!WARNING]
> **Execution superseded as of 2026-07-21.** Do not implement or sequence this legacy PR
> directly. Use the [Complex App Roadmap](../complex-app-roadmap.md) as the execution source
> of truth. This file remains as historical research, verified emission evidence, and design
> rationale; where it conflicts with the roadmap, current code, or current `CLAUDE.md`
> contracts, the current sources win.

## 2026-07-21 rebaseline

**Roadmap mapping:** the surviving SA, MCP, and documentation scope is **S10**.

- Tool-schema acceptance now follows the **OpenAI Responses API** path in
  `scripts/test-schema.ts`, including the agent's wire-schema projection and strict-mode
  normalization. Preserve prompt-cache/schema-size discipline; the legacy Anthropic claim
  below is superseded.
- Chat and MCP remain separate registration surfaces: chat exposes camelCase tool names and
  MCP exposes snake_case names. A new capability is not complete until both manifests and
  their projected schemas are covered.
- Reuse the current field-path and UUID-or-human-id resolvers, refusing ambiguous human ids;
  do not recreate the resolver described below. Clears travel as `null` through the current
  Postgres/JSONB/SSE mutation path, not a Firestore event log.

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
  tool's own Zod (`{ ...tool.inputSchema.shape, app_id }`). A **brand-new** tool needs TWO
  registrations: a `SHARED_TOOLS` entry in `lib/mcp/server.ts` (MCP) AND an entry in the
  chat SA's own tool manifest in `lib/agent` (the tool directory the `ToolLoopAgent` is
  constructed from — the chat side keeps its own list; MCP's is not consumed there). Miss
  the second and the headline goal (chat authoring) silently doesn't ship.
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
  `FormDef::canCreateRepeat` re-resolves per check. **The freeze claim is per-arm**: Nova's
  `count_bound` HOISTED arm (non-path counts hoisted into `__nova_count_*`) is behaviorally
  frozen because that node is seeded once at `xforms-ready`; the DIRECT-PATH arm (a count
  that is already a location path emits `jr:count` pointing at the live authored node) is
  NOT frozen — its cardinality re-resolves as the node changes.
  `lib/commcare/CLAUDE.md`'s "evaluated ONCE at form load" misstates the mechanism for
  both arms and the behavior for the direct-path arm.

## Build

### 1. Display-condition params

`display_condition?: Predicate | null` on `updateModuleInputSchema` and
`updateFormInputSchema`. Boundary: `checkPredicate` under
`displayConditionContext(doc, module, level)` (PR-01) before folding into the patch; on
checker errors return the findings as the tool error (Elm-like, person-to-person). No new
tools; MCP rides automatically.

### 2. Case-operation tools

Four new shared tools mirroring the doc mutations: **`add_case_operations` (LIST-taking —
the house rule: "no singular add-tool has a plural twin", `lib/agent/CLAUDE.md`; one op is
a length-1 array, and the batch is order-resolved so a later op's `{kind:"op", op_id}`
target may reference an op landing in the SAME call — the `addFields` parentId-batch
precedent)**, `update_case_operation`, `remove_case_operation`, `move_case_operation`.
Inputs mirror PR-01's `CaseOperation` shape — `action`, `case_type`, `target`
(discriminated union incl. `{kind:"new", id_from?}` / `{kind:"op", op_id}` /
`{kind:"session"}` / `{kind:"expression"}`), `condition`, `for_each`, `name`, `owner`,
`rename`, `retype`, `writes` (with per-write `condition`), `links` (identifier /
target_type / target-or-null / relationship). **Identity/addressing (stated, not
implied):** the SA passes human-readable identifiers and the tool boundary resolves them
to uuids — `op_id` is the op's SLUG `id` (resolved to `uuid` via the form's op list);
`id_from` and `for_each.repeat` are FIELD PATHS. **The path→uuid resolver must be
written** — no such helper exists today (`lib/doc/fieldPath.ts` exports only the string
primitives `fpath`/`fpathId`/`fpathParent`, and `lib/doc/CLAUDE.md`'s
"`resolveFieldByPath`, `getFieldPath`" line is drift naming symbols that don't exist —
fix that line in §7's sync): a walk over the form's field tree matching slash-delimited
ids, sound because sibling ids are unique per parent (`identifierVerdicts`).
**Identity extends INTO the typed expression ASTs**: PR-01's `field` Term is `{uuid}` and
`id-of` is `{opUuid}`, but the SA never sees field uuids (it speaks ids/paths —
`summarizeBlueprint`'s contract), so the SA-facing predicate/expression sub-schemas carry
a FIELD-PATH variant of the `field` leaf and an OP-SLUG variant of `id-of`, and the tool
boundary AST-walks each expression param rewriting those leaves to their uuid forms BEFORE
`checkPredicate` runs — this covers `condition`, `name`, `owner`, `writes[].value`,
`links`, and §3's `options_source.filter` alike. Ops address by
`(moduleIndex, formIndex, op_id)`; positional resolution uses the sorted
`resolveModuleUuid`/`resolveFormUuid` helpers (never raw array position — the order-sweep
test enforces this). `move_case_operation` takes `{ before_op_id?: string }` (absent =
move to end), resolved to a fractional `order` key via `keysForSlot` — the same landing
the builder drag computes. Each tool prepends the catalog chokepoint MUTATIONS —
`declareCaseType` (idempotent) + one `addCaseProperty` per written property, the exact
pattern `lib/agent/tools/createModule.ts` emits inline; the `Mutation[]`-building
precedents to copy are `lib/doc/scaffolds.ts::declareCaseTypeForField` /
`::caseTypeCatalogMutations` (NOTE: `ensureCatalogProperty` is a reducer-INTERNAL void
appender in `lib/doc/mutations/fields.ts` covering FIELD writes only — it builds no
mutations and cannot be prepended; op writes need the explicit mutations precisely because
no reducer side-effect covers them) — and commits via `guardedMutate`. Register all
four in BOTH the chat SA manifest and `SHARED_TOOLS`.

### 3. Table tools + field params

Tables are **Project-scoped registry data (PR-02), not doc mutations** — so table tools
write through the registry service with Project-membership auth, not `guardedMutate`:

- `create_lookup_table` / `update_lookup_table` / `delete_lookup_table` — schema CRUD
  (tag, name, columns) against the PR-02 registry; deletion blocked with a person-readable
  reference list when any app in the Project references the table.
- `set_lookup_table_rows` — bulk row replace (ordered). The cap is **PR-02's single
  5,000-row constant, imported** (never a second cap invented here); over-cap rejects with
  a message naming the cap and the CSV-import alternative in the builder. Row writes
  validate against column types (PR-02's AJV path).
- `options_source` on the two select kinds: **a hand-written per-property arm** in
  `lib/agent/toolSchemaGenerator.ts` — only new KINDS propagate automatically; SLOTS are
  wired per property. The SA-facing sub-schema:
  `{ table: string /* tag or display name; resolved to tableId at the boundary against the
  registry */, value_column: string, label_column: string, filter?: Predicate }`. The
  API-acceptance check for the widened schemas is `scripts/test-schema.ts` (there is no
  role for the `generate_schema` planning tool here). `table-lookup` / `table-ref` values
  ride the existing expression params once PR-01's parser accepts them.
- Read tools with SPECIFIED outputs (SA context budget is the constraint):
  `list_lookup_tables` returns `{ id, tag, name, columns, rowCount }[]`;
  `get_lookup_table` returns the schema + `rowCount` + the FIRST 25 rows as a sample —
  never the full table.

New tools get chat-manifest + `SHARED_TOOLS` entries (`requires: "edit"`); the two reads
get `requires: "view"`. **Tenancy**: the MCP adapter splices `app_id` into every shared
tool — the target Project for these registry operations derives SERVER-SIDE from that
app's `project_id` (never client-asserted), and the app-level `edit` capability is the
gate for registry writes; the chat-side tools derive the Project from the active app the
same way.

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
  CommCare "Advanced Case Actions" name only as export detail), lookup tables — described
  as SHIPPED for the local `.ccz` path (data embedded in the app) with the HQ push
  documented as arriving in wave 2, and PR-03's interim guard named (a table-referencing
  app is blocked from HQ upload until the push exists), so the docs match observable
  behavior; plus the keep-tables-small doctrine. Write behaviors as what the user sees in
  the builder/preview and in Web Apps — never parser internals.
- `content/docs/mcp/tools.mdx`: rows for every new/changed tool.

### 7. CLAUDE.md sync

`lib/domain` (new vocabulary map lines), `lib/commcare` (menu relevancy + op-block + itemset
emission notes; **the `jr:count` mechanism correction** with the two citations above — the
replacement text must be per-arm: "the hoisted `__nova_count_*` arm is seeded once at
`xforms-ready` (frozen); a direct-path count tracks its node dynamically at navigation" —
do NOT preserve a blanket frozen-cardinality claim. **The same blanket claim lives in
SA-facing text THIS PR edits and must be corrected in the same sweep**: `lib/agent/
prompts.ts` SHARED_TAIL's count_bound line ("evaluates it ONCE at form load and freezes
cardinality") and its bound-modes paragraph ("freeze cardinality at form load"), the
`lib/agent/toolSchemaGenerator.ts` FIELD_DOCS repeat entries, and the repeat-emission
comment in `lib/commcare/xform/builder.ts` — each rewritten per-arm), `lib/case-store`
(lookup rows + registry), `components/builder` (new workspaces/sections), `lib/agent` (new
tool families; also fix `lib/doc/CLAUDE.md`'s drifted `fieldPath.ts` line — see §2).

### 8. Drift sweep

The standing pre-commit sweep: stale comments, v1-punt language, narrow rationales, path
drift across everything this wave touched.

## Tests / acceptance

- Tool-level tests: display-condition set/clear round-trip incl. `null`; op tool → mutation
  → gate rejection surfaces findings; op/field addressing resolution (slug + path → uuid,
  incl. `before_op_id` landing); table tool auth (non-member rejected), the imported
  row cap, reference-blocked deletion; `list_lookup_tables`/`get_lookup_table` output
  shapes (sample capped at 25 rows, rowCount correct).
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
