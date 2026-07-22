# Plan: F5 — Lookup tables

> **Evidence archive — execution superseded 2026-07-21.** This document preserves the 2026-07-06 platform research and rationale. Do not implement it directly. The living execution contract, approved scope, slice status, and current source pins are in `docs/plans/complex-app-roadmap.md`; where they disagree, the living roadmap wins.

*Planning pass, 2026-07-06. Seeded by `docs/research/feature-map.md` §F5; anchors: ACA memo
§2.1 (lookup tables as the third address book), LOC §7 (restore-size doctrine). Platform
facts re-verified 2026-07-06 against `~/code/commcare-hq` (@4e3052a8), `~/code/commcare-core`
and `~/code/formplayer` (whose `libs/commcare` submodule is pinned to the same commcare-core
commit; cited files diffed identical).*

**What ships.** First-class **lookup tables**: app-authored tables with typed columns and
named rows, edited in a builder grid and by the SA, stored with the app (schemas in the
blueprint; rows in the case store's Postgres, beside case data), referenced from Nova's typed
expression families (a new `table-lookup` value arm) and from select questions (a new
`options_source` that emits real `<itemset>`s), delivered to the wire two ways — embedded
`<fixture>` data in the local `.ccz`, and an API push to CommCare HQ alongside app upload —
and served to the preview from Postgres.

---

## 1. Verified platform facts + lifecycle citations

| # | Fact | Citation | Verdict |
|---|---|---|---|
| 1 | HQ's model: `LookupTable` (`(domain, tag)` unique, tag ≤ **32 chars**, `is_global`, `fields: TypeField[]` where TypeField = `{name, properties[], is_indexed}`, table-level `item_attributes` names) + `LookupTableRow` (`fields: name → [{value, properties{}}]`, `item_attributes{}`, int `sort_key`) + `LookupTableRowOwner` (user/group/location row ownership; global tables skip it). | `commcare-hq/corehq/apps/fixtures/models.py::LookupTable/TypeField/LookupTableRow/LookupTableRowOwner`; `LookupTableRowManager.iter_by_user` | Alive (plain SQL models, no gating). |
| 2 | Restore wire shape for `tag=products`: `<fixture id="item-list:products" user_id="…"><products_list><products attr…><field prop-attrs…>value</field>…` — list element `{tag}_list`, item element `{tag}`, field `properties` → attributes on the field element, `item_attributes` → attributes on the item element, missing field → empty element, rows ordered by `sort_key`. Indexed tables additionally emit a `<schema id="item-list:tag"><indices><index>col</index>…` node and `indexed="true"` on the fixture. | `fixtures/fixturegenerators.py::ItemListsProvider._get_fixture_element/to_xml/_get_schema_element`; `fixtures/utils.py::get_index_schema_node/clean_fixture_field_name` | Alive. The shape Nova's emitter and push output must both match (§3.4). |
| 3 | Canonical in-app reference: `instance('item-list:tag')/{tag}_list/{tag}[pred]/field`; suite instance declared by scheme convention `item-list:` → `src="jr://fixture/item-list:tag"` (`generic_fixture_instances` factory). | `app_manager/xpath.py::ItemListFixtureXpath`; `suite_xml/post_process/instances.py::generic_fixture_instances` | Alive. |
| 4 | **The API writes.** JSON REST: `lookup_table` (v0.5/v1) + `lookup_table_item` (v0.5/v1/v0.6) — list GET/POST, detail GET/PUT/DELETE, **no PATCH**; table `tag` is **immutable on PUT** and duplicate-`tag` POST rejects; row identity is UUID-only (re-POST appends). Excel bulk: `POST /a/<domain>/fixtures/fixapi/` (`upload_fixture_api`) — API-key auth, `replace=true|false` (full-replace vs merge), sync or async with a pollable status URL. Auth for the REST resources = `LoginAndDomainAuthentication` (API key works) + standard throttle. | `fixtures/resources/v0_1.py` (methods, `obj_create/obj_update` guards), `v0_6.py`; `corehq/apps/api/urls.py`; `fixtures/views.py::upload_fixture_api/_upload_fixture_api`; `upload/run_upload.py::_run_upload/_would_discard_rows`; `api/resources/meta.py::CustomResourceMeta` | Alive. Verified independently by the planning session (methods lists in v0_1.py). |
| 5 | Code-level caps: **500,000 rows per uploaded workbook** (`MAX_FIXTURE_ROWS`) is the only hard cap; no cell-size validators; restore generation never truncates or pages item-list fixtures (global blobs cached per table, per-user id byte-substituted). | `fixtures/upload/const.py::MAX_FIXTURE_ROWS`; `upload/workbook.py`; `fixturegenerators.py::_get_or_cache_global_fixture` | Alive. |
| 6 | **HQ never ships item-list data in the app package** — `create_all_files` writes no fixture-data file; the only suite `<fixture>` HQ emits is the demo `user-groups` stub. Data reaches devices via OTA restore only, on the HQ path. | `models.py::Application.create_all_files`; `suite_xml/sections/fixtures.py::FixtureContributor` | Alive. Hence the API push is mandatory for HQ-uploaded apps (§3.4). |
| 7 | **But the client installs suite-embedded fixture data**: `SuiteParser` handles `<fixture>` → `FixtureXmlParser` into the platform's app-fixture storage ("commit fixture to the memory, overwriting existing fixture only during first init after app upgrade") — the SAME storage `instance()` resolution reads. A fixture element with no `user_id` attribute stores as **global** (`META_XMLNS=""`), matched first from app-fixture storage. | `commcare-core/.../xml/SuiteParser.java` (case `"fixture"`), `FixtureXmlParser.java::setupInstance`, `SuiteInstaller.java`, `CommCarePlatform.java::getFixtureStorage`, `SandboxUtils.java::loadFixture/loadAppFixture` (verified independently by the planning session for the SuiteParser arm) | Alive on the client; **no HQ emitter produces this shape for item-lists** — the wire authority is the client parser (+ HQ's own `user-groups` suite fixture as the precedent). Nova pins its own fixtures. |
| 8 | Instance resolution contract: `instance('X')` matches a **declared** `<instance id="X" src="jr://fixture/Y">` exactly; `Y` (substring after the last `/`) must exactly equal the delivered fixture's id; X and Y are independent ids. Suite-side expressions (case lists, menus, entries) resolve fixtures identically to in-form — **only if declared on the referencing element**; undeclared → "Instance not found" XPathException; missing fixture → `FixtureInitializationException` ("Unable to find lookup table: …"). | `commcare-core/.../CommCareInstanceInitializer.java::setupFixtureData/loadFixtureRoot`; `VirtualInstances.getReferenceId`; `CommCareSession.java::getEvaluationContext`; `EvaluationContext.java::getInstance` | Alive. Confirms F1's declared-instances rule extends to `item-list:` ids. |
| 9 | Itemset contract (JavaRosa): `<itemset nodeset>` required and must parse as a **path** (predicates allowed in nodeset only); `<label ref>` required (fixture path or `jr:itext(...)`); `<value ref>` (or `<copy>`) required, predicate-free path; `<sort ref>` optional; literal `<item>`s + `<itemset>` together is a parse error. Choices re-evaluate when the prompt rebuilds (navigation), so answer-dependent filters re-filter. | `commcare-core/.../XFormParser.java::parseItemset`; `ItemSetParsingUtils.java`; `ItemsetBinding.java`; `ItemSetUtils.java::populateDynamicChoices`; `FormEntryPrompt.java::getSelectChoices` | Alive. |
| 10 | Indexed fixtures route purely on the restore's `indexed="true"` attribute + a `<schema>` block — no id allowlist; un-indexed fixtures load as in-memory trees; formplayer stores fixtures per-user in SQL and indexed ones as their own tables. | `commcare-core/.../CommCareTransactionParserFactory.java::getParser`; `IndexedFixtureXmlParser.java`; `FixtureIndexSchema.java`; `formplayer/.../UserSqlSandbox.java`, `FormplayerInstanceInitializer.java` | Alive; **orthogonal scaling choice — deferred** (Nova v1 tables are small reference data). |
| 11 | `ModuleBase.fixture_select` (the pre-case-list "Due List" fixture picker) is gated by `FIXTURE_CASE_SELECTION` — `TAG_DEPRECATED`, ICDS-named. | `commcare-hq/.../models.py::FixtureSelect`; `toggles/__init__.py::FIXTURE_CASE_SELECTION` | **Deprecated — not modeled.** |
| 12 | Case-search prompts can carry itemsets (fixture-backed select search inputs) — `search_config.properties[*].itemset`; Nova currently rejects select search widgets for exactly this missing infrastructure. | `fixturegenerators.py` (itemset fixture deps); `instances.py`; Nova: `validator/rules/case-list/searchInputSelectWidgetNotSupported.ts`, `suite/case-search/searchPrompts.ts` (forward-projected emission) | Alive on HQ; **Nova follow-on consumer** (§4). |

Nova-side seams (from the codebase map, all verified in-worktree): the two extension seams
the code names explicitly — `lib/commcare/validator/rules/field.ts::MODELED_INSTANCE_IDS`
("this set extends in lockstep") and `lib/commcare/predicate/instances.ts::instanceSourceFor`
— plus: select options are inline `<item>`s keyed by index with no itemset slot (the XForm
oracle currently *rejects* itemsets defensively); the `caseTypes` collection is the clone
template for an app-level collection (keyed mutations, declaration chokepoint, retirement
cascade, `t:` reference edges); the preview evaluator stubs ALL `instance()` calls to `""`;
the blueprint doc is hard-capped near Firestore's ~1 MiB (`BLUEPRINT_REQUEST_MAX_BYTES`
rationale), with media as the established bulk-data-out-of-doc precedent; the case-store has
exactly four tables (no auxiliary storage); the HQ client has five HTTP call sites and no
fixtures client; the id-mapping/image-map columns are per-column embedded value→label maps,
not tables.

## 2. The shape question (protocol 3)

**CCHQ's authoring shape** — a tag-keyed fixture with stringly columns, Excel as the real
editor, per-value `properties`, and raw-XPath consumption — is not inherited. **Nova's
shape**:

```ts
// blueprintDocSchema — new app-level collection, cloning the caseTypes pattern
lookupTables: z.array(lookupTableSchema).nullable(),

lookupTableSchema = {
  uuid: Uuid,            // stable identity (mutations, references survive renames)
  tag: string,           // wire identity: fixture id item-list:<tag>, HQ push key.
                         //   XML-name + ≤32 chars (HQ cap) enforced at construction.
  name: string,          // display name
  columns: Array<{ name: string, label: string, data_type?: CasePropertyDataType }>,
  description?: string,
}
```

- **Typed columns** (charter Q1): yes — `data_type` reuses the case-property type vocabulary
  (one declarable-type set repo-wide). The wire is untyped strings (fact 2); types live at
  the authoring layer for validation, the checker, and the Postgres value schema — the same
  philosophy as case properties.
- **Rows are NOT doc content.** They live in a new Postgres table beside case data
  (`lookup_rows`: `(app_id, project_id, table_uuid, row_id, order, values JSONB)`), for the
  same reasons case rows do: the blueprint doc has a ~1 MiB ceiling, rows are queryable data
  the preview needs SQL over, and the media precedent already establishes
  bulk-bytes-out-of-doc with ids in-doc. Row edits are data writes (like "sample data writes
  real rows"), not undoable doc mutations; the schema (table + columns) is doc content with
  full undo/multiplayer semantics.
- **What Nova deliberately drops from CCHQ's model**: per-value `properties` (multi-valued
  cells — none of the observed uses need them; a widening note covers them), table-level
  `item_attributes` as a separate axis (Nova columns can emit as attributes where the wire
  needs them — the emitter decides; v1 emits all columns as child elements plus a stable
  `@id` item attribute for value-referencing), and row-level ownership (F3-adjacent;
  v1 tables are global — fact 1's `is_global=true`).

**References are typed, never stringly** (charter Q1's second half):
- A new **`table-lookup` ValueExpression arm**: `{ kind: "table-lookup", table: <name/uuid>,
  column, where: Predicate }` — reads one column from the rows matching `where` (checked in
  a new table-column scope). This is the address-book read (ACA §2.1's
  `instance('item-list:bhaso_regions')/…[region = X]/@id`), landing exactly where F4 needs
  it (op `owner` expressions), plus calculated columns and F1 display conditions.
- A new **`options_source` slot on the two select kinds** (mutually exclusive with inline
  `options`): `{ table, valueColumn, labelColumn, filter?: Predicate }` — emits a real
  `<itemset>` per fact 9.
- **Raw-XPath table access stays rejected**: `FIXTURE_REFERENCE_NOT_MODELED` continues to
  guard the parts-AST surface (its message updates to point at the two new affordances).
  Consistent with F1's no-raw-XPath posture; arbitrary in-form table reads are a recorded
  deferral, not an accident.

## 3. Charter closure

### 3.1 Schema + AST identity (charter Q1)
Answered in §2. Identity mechanics: tables are referenced by `uuid` in AST slots and printed
by current `tag`/name (rename-safe); columns are name-keyed identity co-owned by their
writers, exactly like case properties — renames cascade structurally over the reference
index's new edges (`lt:<table>` names-a-table, `ltc:<table>/<column>` reads-a-column), via
new arms in the exhaustive extraction/rewrite switches. The type checker gains the
table-column scope; the card editor's slot constraints derive from the same checker rules
(the standing no-second-table contract).

### 3.2 Scope: per-app; rows Project-visible (charter Q2)
Table schemas are per-app (in the blueprint, like `caseTypes`). Rows key on
`(app_id, project_id)` — the same tenancy axis as case rows, so Project co-members see and
edit the same rows through the same membership gate (`gatedCaseStore` pattern). Cross-app /
Project-shared tables are deferred until a real use case appears; the media analogy (shared
assets) doesn't transfer because table *schemas* are app-coupled (expressions reference
columns). Preview storage (charter's "case-store adjacency?"): yes — the new `lookup_rows`
table in the case store's Postgres, served by server actions, with the table's column types
compiled to a value validator on write (AJV, mirroring case properties).

### 3.3 Preview execution
- `options_source` selects: choices resolve server-side per form session (query
  `lookup_rows` with the compiled filter; ordered rows). v1 filters range over table
  columns, session terms, and literals only — an answer-dependent choice filter needs a
  field-ref Term the Predicate family deliberately lacks; the wire supports re-filtering on
  prompt rebuild (fact 9), so this is a recorded widening, not a wall.
- `table-lookup` in expressions: joins F1's evaluation pattern — a SQL residue evaluated
  through the case store (new table-scope compile path reusing the compileTerm machinery),
  batched with the F1 display-condition action where applicable.
- The preview evaluator's `instance()` stub is untouched — table data reaches the engine as
  resolved data (choices, expression results), never as XPath instance trees, mirroring how
  case data flows today.

### 3.4 Export + push (charter Q3)
Two delivery mechanisms, one authored artifact, with a **body-parity rule** binding them:
Nova's emitted fixture body must byte-match what HQ's `ItemListsProvider` will serve for the
same table after a push (same `{tag}_list/{tag}` naming, same field-element convention, same
ordering) — so the app's compiled XPaths work identically whichever path delivered the data.
- **Local `.ccz`**: embed each table as a global `<fixture id="item-list:<tag>">` (no
  `user_id` attribute) in suite.xml — verified client-installed into the same storage
  instance resolution reads (fact 7), upgrade-overwritten. HQ never emits this shape for
  item-lists (fact 6), so the authority is the client parser; Nova pins its own fixtures
  against `FixtureXmlParser`/`SuiteParser` behavior and notes the HQ-fixture gap explicitly.
  This keeps the exported `.ccz` self-contained — the same posture as the caseListOnly
  browse-command precedent.
- **HQ upload**: a push phase after `importApp` succeeds (the media-bytes precedent: app
  first, assets after, degrade-to-warning failure contract): ensure table by `tag` (POST; on
  existing, PUT structure by UUID — tag is immutable on HQ, fact 4), then replace rows.
  Rows via the Excel `fixapi` bulk endpoint (`replace=true`, async + status poll) as the
  primary path — it is content-keyed and stateless, avoiding row-UUID bookkeeping; the JSON
  row resources remain the verified fallback. A Nova tag rename after a prior push =
  delete-by-old-tag + create-new (documented; push and app upload travel together so
  references stay consistent).
- **Instance declarations**: every consuming surface declares
  `<instance id="item-list:<tag>" src="jr://fixture/item-list:<tag>"/>` — XForm models (via
  the model-instance scan), suite entries/menus (via the accumulation seams:
  `addTermInstance` gains the `table-lookup` arm; `instanceSourceFor` gains the
  `jr://fixture/` scheme arm), per fact 8.
- **Restore-size doctrine** (LOC §7): tables are restore payload on the HQ path; SA guidance
  + docs carry the keep-tables-small doctrine; a practical per-table row guard lives at the
  row-writing surfaces (not the validator — rows aren't doc content). Indexed-fixture
  emission (fact 10) is deferred until a size case appears.

## 4. Explicitly deferred (recorded, with evidence)

- Row-level ownership (user/group/location) — F3-adjacent; the wire + model are verified
  (fact 1) for when locations land.
- Answer-dependent choice filters (fact 9 supports them; needs a field-ref Term — a
  deliberate AST widening decision).
- Arbitrary in-form table reads via XPath parts (a `table-ref` leaf design exists in
  outline; `FIXTURE_REFERENCE_NOT_MODELED` keeps guarding until then).
- Indexed fixtures (fact 10), per-value `properties`, `item_attributes` authoring.
- Search-input itemsets (fact 12) — the `searchInputSelectWidgetNotSupported` rule can lift
  once F5's itemset infrastructure exists; owned by a follow-on to the case-search surface.
- `fixture_select` module datum — deprecated (fact 11), never modeled.

## 5. Full-stack scope (protocol 4)

Domain (`lookupTables` collection + `options_source` + `table-lookup` arm + table-column
check scope + reference edges + rename cascades); doc/mutations (keyed table/column mutation
family cloning `declareCaseType`/`retireCaseType` + chokepoint + retirement-style
orphan handling when a referenced table is removed — block with references, like case-type
retirement); validator (new codes + classes + repair judgments: unknown table/column,
type errors in `where`/`filter`, options_source ⊕ options exclusivity, tag legality; update
`FIXTURE_REFERENCE_NOT_MODELED`'s message; extend the XForm oracle to ACCEPT well-formed
itemsets per fact 9 while still rejecting items+itemset); case store (`lookup_rows` table +
Kysely migration + store API + AJV write validation + row server actions); emitters
(itemset emission + suite-embedded fixture + instance declarations + HQ push client
functions + upload-route phase); preview (§3.3); builder UI (tables workspace: schema editor
+ rows grid; select-field options-source picker; expression card support); SA + MCP (table
schema tools + bulk row tool with payload caps + options_source/table-lookup params +
prompt guidance: the three verified use patterns, the keep-small doctrine, "reshape
option-list-like data into tables when shared/large"); docs (authoring page + tools.mdx +
CLAUDE.md updates); migration: none (additive; existing id-mapping columns stay as-is —
they remain the right tool for tiny inline value→label display maps; guidance says when to
graduate to a table).

## 6. Execution prompts

Serialized P1 → P2 → P3 → P4 → P5 → P6, with P4 parallelizable against P3 after P1–P2.

---

**P1 — Domain collection + validator.**
> Implement F5's domain layer per `docs/plans/2026-07-06-f5-lookup-tables.md` §2, §3.1, §5.
> `lookupTables` collection cloning the `caseTypes` pattern (schema slot, keyed mutations,
> declaration chokepoint where references can outrun declarations, removal blocked by a
> reference list — cite `caseTypeRetirement.ts` as the template); reference-index edges +
> rename cascades; validator codes + classes + repair judgments; tag legality (XML name,
> ≤32 chars per the HQ cap, unique per app).
> **Open for implementer:** whether column renames cascade (recommend yes — clone the
> case-property rename walk) or block-with-references; the exact code granularity.

**P2 — Rows store.**
> Implement the `lookup_rows` Postgres table per plan §2/§3.2 (P1 landed): Kysely migration
> + `database.ts` lockstep type, store API (list/replace-rows/upsert per-row, ordered),
> AJV validation compiled from column types, Project-membership-gated server actions, and
> the practical row-count guard at write surfaces.
> **Open for implementer:** row identity (recommend server uuid + fractional order key
> mirroring the doc's order model); the guard's default cap; whether row edits emit any
> run-log event (recommend: same treatment as sample case-data writes today).

**P3 — Typed references: `table-lookup` + `options_source`.**
> Implement F5's AST work per plan §2, §3.1, §3.3 (P1–P2 landed). The `table-lookup`
> ValueExpression arm through EVERY exhaustive-switch site (walkers, rewriter, type checker
> with the new table-column scope, Postgres compiler table-scope path, on-device XPath
> emitter → `instance('item-list:tag')/{tag}_list/{tag}[where]/col`, instance accumulation:
> `addTermInstance` + `instanceSourceFor` gain their arms — the two seams the code already
> names; CSQL: reject with a representability error), card-editor slot constraints, and
> admission rules (display conditions, calculated columns, F4 owner expressions when both
> land). `options_source` on the two select kinds (⊕ inline options), preview choice
> resolution server-side, F1-evaluator residue integration.
> **Open for implementer:** `where` ergonomics in the card editor (single-row-match UX);
> what a multi-row `table-lookup` match yields (recommend: first-match by row order,
> documented — XPath takes the first node; Postgres LIMIT 1 by order — keep both targets
> agreeing); whether `options_source.filter` admits session terms in v1.

**P4 — Wire emission + oracle.**
> Implement F5's export per plan §3.4 (P1–P3 landed). Itemset emission on both select kinds
> (nodeset with compiled filter predicate; label/value refs matching the body naming;
> instance declaration in the XForm model); suite-embedded global `<fixture>` blocks in the
> local `.ccz` with the body-parity rule against HQ's `ItemListsProvider` shape (pin Nova
> fixtures; note the HQ-fixture gap — the authority is `SuiteParser`/`FixtureXmlParser`);
> extend the XForm oracle to accept well-formed itemsets (fact 9's exact contract) and the
> suite oracle to resolve `item-list:` instance refs against the app's declared tables.
> **Open for implementer:** whether the label ref uses fixture-path labels or itext
> (recommend fixture-path — single-language today, and it matches the Vellum canonical);
> where in suite.xml the fixture blocks sit (any position `SuiteParser` accepts — pick one,
> pin it).

**P5 — HQ push.**
> Implement the push phase per plan §3.4 (P4 landed): client functions on `lib/commcare`'s
> HQ client (reuse the CSRF/WAF/auth machinery; the Excel `fixapi` bulk path with
> `replace=true` + async status polling as primary, JSON REST table-ensure as structure
> path), wired as the third upload phase after `importApp` with the media-phase failure
> contract (degrade to warning, precise person-readable message).
> **Open for implementer:** xlsx generation approach (a minimal writer vs a dependency —
> check what the repo already ships before adding one); push idempotency bookkeeping
> (recommend stateless: resolve table UUID by listing + tag match per push); how tag renames
> surface to the user at push time.

**P6 — Builder UI, SA, docs.**
> Implement F5's authoring surfaces per plan §5 (P1–P5 landed): the tables workspace
> (schema editor + rows grid, Project-shared rows), the select-field options-source picker,
> SA tools (table schema CRUD + bulk rows with payload caps + the new expression/options
> params) + prompt guidance (the three verified use patterns: select options at scale,
> address-book lookups, friendly-id data; the restore-size doctrine; when id-mapping columns
> suffice), tools.mdx + authoring docs page + CLAUDE.md updates, feature-map §F5 → pointer,
> drift sweep.
> **Open for implementer:** grid interaction details (load frontend-design skill); CSV/Excel
> import into the rows grid (recommend v1 CSV paste/upload — cheap and matches how users
> hold this data); SA guidance wording.

---

## 7. Risks + notes

- **The suite-embedded-fixture shape has no HQ emitter precedent for item-lists** — the
  user-groups stub and the client parser are the authorities. If a runtime regression ever
  surfaces, the fallback is HQ-push-only delivery (the `.ccz` loses standalone tables but
  nothing else changes).
- **Upgrade-only overwrite semantics** (fact 7's comment): embedded fixture data refreshes
  on app upgrade, not on every login — matches "tables ship with the app version"; documented.
- **Same-id collision** between an embedded fixture and a restore-delivered one (post-push
  HQ apps re-installed locally): user-fixture storage is consulted before app-fixture
  storage (`SandboxUtils.loadFixture` order), so restore data wins where both exist —
  acceptable (they're the same table by the parity rule), recorded for the implementer.
- The **32-char tag cap** and slug rules are enforced at construction so the HQ push can
  never fail on identity grounds.
