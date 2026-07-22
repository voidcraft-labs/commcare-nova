# PR-02: Project-scoped lookup tables — storage + registry

> [!WARNING]
> **Execution superseded.** This document is retained as historical evidence and rationale,
> not as an implementation checklist. Execute from the living
> [complex-app roadmap](../complex-app-roadmap.md) and its current slice contracts instead.

## 2026-07-21 rebaseline

Execution of this legacy PR is now split across **S01 and S02**. Preserve the verified HQ
fixture, identifier, and push constraints below; the Firestore design and split-store
failure model are obsolete after Nova's app-state migration.

- Lookup definitions, columns, rows, ordering, permissions, and governance are Postgres
  only, using the shared migration and transaction discipline. No Firestore collection,
  index document, listener, or Firestore blueprint scan is part of the implementation.
- Every table and column has a stable UUID. Wire tags and column names are projections,
  with database-backed Project uniqueness and legality constraints where applicable.
- Exact table and column reference edges are maintained transactionally with accepted app
  mutations; destructive changes consult those edges under an explicit lock order rather
  than racing a project-wide scan.
- Registry snapshots used by commits and exports are authoritative and Project-scoped.
  Foreign-Project references fail as not found, and app moves are blocked while referenced
  Project resources would be stranded.
- Realtime invalidation, if required by the slice, uses the existing Postgres notification
  model. Role policy follows current Project capabilities rather than assuming every member
  can edit.

*Self-contained implementation plan. Reference rationale: `docs/plans/2026-07-06-f5-lookup-tables.md`
§1–§3 (verified platform facts) — REVISED by owner ruling: tables are **Project-shared**, not
per-app. Scope rulings in `docs/plans/2026-07-06-pr-execution-plan.md` apply.*

**Goal.** Lookup tables exist as real, shared data: a Project defines a table once (columns +
rows), every app in the Project can reference it, and every co-member sees and edits the same
rows — the same sharing model case data and media already have. This PR builds the storage,
the write surface, and the read-only registry that PR-01's validator checks and PR-04's
preview consume. Nothing renders in the app yet (PR-03 emits, PR-04 previews, PR-05 gives it
UI).

## What the user gets (via later PRs)

A "Tables" concept per Project: define a `regions` table in one app, reference it from
another; a teammate updates a row and both apps' previews see it. This PR makes that data
layer exist and be queryable/validatable.

## Verified contracts this PR relies on

- **The blueprint doc cannot hold rows.** The doc persists as one Firestore document field,
  hard-capped by **Firestore's ~1 MiB document limit**; the repo's own request cap
  (`lib/apiError.ts::BLUEPRINT_REQUEST_MAX_BYTES` = 2 MB) exists to leave envelope headroom
  over exactly that limit (its comment says so). Bulk data lives OUT of the doc with ids
  in-doc — the established media pattern (bytes in GCS, status rows in
  `lib/db/mediaAssets`, `project_id` set authoritatively at upload and used as the only
  access gate — root `CLAUDE.md` §media).
- **Project membership is the sharing gate.** Case rows are tenant-scoped
  `(app_id, project_id)` and every read goes through membership resolution
  (`lib/preview/engine/caseDataBindingHelpers.ts::gatedCaseStore` →
  `withProjectContext(projectId, actorUserId)`); media reads/lists authorize Project
  membership the same way. Tables adopt the identical gate.
- **HQ's model bounds Nova's identity rules** (verified in the F5 pass,
  `commcare-hq/corehq/apps/fixtures/models.py::LookupTable`): `tag` ≤ **32 chars**, unique
  per domain, **immutable on PUT** (`resources/v0_1.py::LookupTableResource.obj_update`
  rejects tag changes); rows carry an integer `sort_key` and the JSON row API has UUID-only
  identity (no natural key) — which is why the Excel `fixapi` bulk path with `replace=true`
  is the push primitive (PR-11 consumes; this PR only guarantees tag legality + stable
  ordering).
- **The wire shape the rows must serialize into** (PR-03/PR-11):
  `<fixture id="item-list:{tag}"><{tag}_list><{tag}><col>value</col>…` with rows in order —
  the `<fixture>`/`<{tag}_list>` wrappers come from
  `fixtures/fixturegenerators.py::ItemListsProvider._get_fixture_element`; `to_xml` builds
  the inner row element. Column/tag `name` legality is therefore **stricter than bare XML
  element names**: XML-element-name-legal AND not starting with `xml` (any case) AND no
  colons — HQ's own fixture path slugifies/rejects exactly these
  (`fixtures/utils.py::clean_fixture_field_name`; the `fixapi` upload path validates via
  lxml element construction). Enforce the full rule at creation so no later push can fail
  on identity grounds.
- **The case store's write-validation precedent**: per-type JSON Schema compiled from
  declared properties, enforced by AJV at write time with `additionalProperties: false`
  (`lib/domain/predicate/jsonSchema.ts::caseTypeToJsonSchema`,
  `lib/case-store/postgres/store.ts::validateProperties`). Tables mirror it per-table from
  column types.

## Build

### 1. Table definitions — Firestore per-Project collection (`lib/db/lookupTables.ts`)

The `mediaAssets` pattern, definition-shaped:

```ts
LookupTableDef = {
  id: string,            // Firestore doc id (uuid) — the id apps reference (PR-01's tableId)
  project_id: string,    // authoritative at creation, never self-asserted
  tag: string,           // wire + push identity: XML-element-name-legal, ≤32 chars,
                         //   unique per Project (enforced at creation via a tag index doc
                         //   or transaction — pick one, test the race)
  name: string,          // display name
  columns: Array<{ name: string, label: string, data_type?: LookupColumnDataType }>,
  createdBy: string, createdAt/updatedAt: Timestamp,
}
// LookupColumnDataType = the SCALAR subset of the ACTUAL case-property vocabulary
//   (lib/domain/casePropertyTypes.ts::casePropertyDataTypes — spelled exactly):
//   "text" | "int" | "decimal" | "date" | "time" | "datetime" (default text).
//   select/multi_select/geopoint are excluded (no table-cell semantics). There is NO
//   boolean — CommCare has no boolean data type and the predicate checker coerces
//   booleans to text (typeChecker.ts's literal-type note); flag-like columns are text
//   ("yes"/"no"), matching case-property practice.
// The read-only projection PR-01's validator consumes is exported from here as
//   LookupTableSnapshot = Pick<LookupTableDef, "id" | "tag" | "name" | "columns">.
```

- CRUD helpers with Project-membership authorization on every read/list/write (mirror
  `lib/db/mediaAssets`'s gate; `project_id` from the resolved active Project, never the
  client).
- **Column governance (decided, not open — "append + gated removal"):** columns can always
  be ADDED; `label` is always editable (labels are display-only — nothing references them);
  `data_type` is editable **only at zero references to that column** (a type change under a
  referencing expression would silently retype it) and re-validates existing rows when it
  runs; column **removal**, **column rename**, and **tag change** require a **project-wide
  reference scan returning zero references** — the server walks every app doc in the
  Project (blueprints are Firestore fields; the scan reads each app's
  `options_source`/expression carriers via the reference-slot registry) and rejects with a
  person-readable list of referencing apps otherwise. Table **deletion** has the same
  zero-reference rule, and executes **rows first (Postgres), then the definition
  (Firestore)** — a failure between the two leaves a row-less definition that is harmless
  and re-deletable (test this ordering). This is the cross-app analog of
  `caseTypeRetirement.ts`'s block-with-references, hoisted server-side because references
  live in OTHER docs.

### 2. Rows — Postgres `lookup_rows` (`lib/case-store`)

- Kysely migration (new module in `lib/case-store/migrations/`) + `sql/database.ts` lockstep
  type (the four-table `Database` interface gains `lookup_rows`):

```
lookup_rows: project_id text, table_id text, row_id text (uuid),
             "order" text (fractional key, lib/doc/order semantics),
             values jsonb, created/modified timestamps
PRIMARY KEY (project_id, table_id, row_id)   -- the composite IS the identity;
                                             -- upsertRow's ON CONFLICT targets it
index: (project_id, table_id, "order", row_id)
```

- No `app_id` — rows are Project-scoped by design (the ruling). No owner column.
- Store API on the case-store package (same pool, same migration owner):
  `listRows(tableId)` ordered; `replaceRows(tableId, rows[])` (transactional full-replace —
  the CSV-import and SA-bulk primitive); `upsertRow` / `deleteRow` / `moveRow` (fractional
  order via `keysForSlot`); every method takes the Project context from
  `withProjectContext` — clone the `gatedCaseStore` wrapper as `gatedLookupStore`.
- **AJV write validation** compiled per table from `columns` (`additionalProperties:
  false`; JSON types per `LookupColumnDataType` — text/date/datetime as strings,
  int/decimal as numbers, everything else — text/date/time/datetime — as strings) — mirror
  `caseTypeToJsonSchema` +
  `validateProperties`, one shared "compile column schema" helper so PR-04's preview
  validation reuses it. **Type-coercion locus: the import/write boundary** — CSV parsing
  yields strings for every cell, so the server action coerces each cell per its column's
  `data_type` BEFORE AJV runs (per-cell errors collected and reported together; the import
  is atomic — all rows or none).
- **Row-count guard** at every write surface (server actions + SA tool): default cap
  5,000 rows/table (constant, one home) with an Elm-like rejection naming the cap and the
  restore-size rationale; NOT a validator finding (rows aren't doc content).

### 3. Server actions — new `lib/lookup/` home (decided)

A thin, membership-gated action layer: storage stays in `lib/case-store` (same pool,
same `Migrator`), definitions in `lib/db/lookupTables.ts`, and `lib/lookup` composes the
two behind typed actions. It imports neither `lib/commcare` nor `lib/preview` (no biome
allowlist change needed); the builder and preview consume IT.

- `listTables()` / `getTableWithRows(tableId)` / mutation actions per §1–§2, all
  membership-gated, all returning typed results the builder/preview consume.
- CSV import: one action accepting parsed rows (client parses; server validates via the AJV
  schema + cap) feeding `replaceRows`. v1 is paste/upload-CSV only (no xlsx).

### 4. Registry hydration (read-only) — the seam PR-01's validator consumes

- The builder session and the chat route's working-doc load both hydrate the Project's
  `LookupTableSnapshot[]` alongside the blueprint (the same boundary that eagerly builds
  `refIndex`); it lands in a read-only `lookupTableRegistry` slot on the validation context
  (NOT in the doc, never serialized with it). **Freshness contract:** the builder session
  subscribes to the Project's table-definition collection (Firestore listener, the live
  pattern the app doc itself uses) so a table CREATED by a co-member after session load
  becomes referenceable without a reload; the `TABLE_REFERENCE_UNKNOWN` rejection message
  says "…or the registry hasn't refreshed — retry" for the residual race window.
- **Ownership boundary with PR-01 (which lands SECOND and owns the validation side):**
  this PR delivers the `LookupTableSnapshot` type export, the gated read/list surface, and
  the Firestore listener above — nothing more. The gate/context signature change
  (`mutationCommitVerdict`'s optional `context.tables`), the threading into
  `validateBlueprintDeep`/`tableScope`, the `TABLE_REFERENCE_UNKNOWN` and options-source
  checks, and every reference-dependent behavior are **PR-01 deliverables** (no table
  reference is even expressible in a doc until PR-01's schema slots exist). MCP/API-path
  hydration is likewise wired by PR-01 against this PR's read surface.

## Tests / acceptance

- Firestore-membership matrix: co-member sees/edits; non-member rejected on every helper.
- Tag legality + per-Project uniqueness incl. the concurrent-create race test.
- Column governance: add/label-edit pass; remove/rename/tag-change **allowed when the
  project-wide scan returns zero references** (the only state expressible before PR-01 —
  no schema slot can reference a table yet); the scan machinery is exercised here against
  a seeded synthetic reference edge, and the real referencing-app block cases land in
  PR-01's test plan alongside the slots that create references; data_type edit re-validates
  rows.
- Row store: AJV rejections per data_type; replaceRows transactionality; fractional-order
  stability; the cap.
- Registry hydration: the snapshot listener delivers creates/updates/deletes to a
  subscribed session; the read surface is membership-gated. (The validation-side tests —
  known-table validates, unknown-table introduce-gated finding, builder/MCP commit-gate
  parity — are PR-01's, where table references first become expressible.)
- `npm run db:migrate` applies clean; `lint/typecheck/test` green; `test:leaks` on touched
  tests.

## Non-goals

Wire emission and body parity (PR-03), preview choices/expression evaluation (PR-04), the
tables workspace UI + CSV UX polish (PR-05), SA tools (PR-06), the HQ push (PR-11 — note
for it: **tag is the push identity**; a Nova tag change, already reference-gated here,
implies delete-by-old-tag + create on the next push).

## Open choices (implementer)

- Tag-uniqueness mechanism (transaction on a tag-index doc vs query-then-create with a
  uniqueness backstop) — pick one, prove the race test.
- Whether `replaceRows` preserves row ids for unchanged content (nice for future diffing;
  not required by any consumer yet).
- The reference-scan implementation (walk app docs via the registry slots vs a maintained
  per-Project reference count) — walk first; count only if the walk measurably hurts.
