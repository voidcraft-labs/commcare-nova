# Complex app plan

Nova's plan for building complex CommCare apps: lookup tables, display
conditions, case operations, case tiles, media capture, users and locations,
automations, and HQ deployment.

This is the only planning document for that program. It describes the system as
it is today and the work that remains. Its primary sources are the two research
memos in `docs/research/` — `advanced-case-actions.md` and
`commcare-locations.md` — which stay as evidence; where a memo and this document
disagree, this document wins. It carries no history: what shipped, when,
in which PR, and against which revision lives in git. When behavior changes, this
file changes with it in the same PR.

Two audiences: someone who needs to know what Nova can do today reads
[What is built](#what-is-built); someone about to implement reads
[What remains](#what-remains), where each unit states its contract, the platform
facts that bind it, what a user observes, and the PR it ships as.

Every CommCare citation uses stable names (`file::function`), never line numbers
— upstream lines rot silently.

---

## Delivery discipline

**Ship the end state.** A unit ships what it will finally be and nothing else. No
version floors, capability leases, reader-version gates, staged activation flags,
traffic-split controllers, or compatibility shims between a unit's own PRs. Work
splits across PRs for review, but no PR carries code that exists only because of
the split.

**Instant live.** A merge to `main` builds one image, runs pending migrations as a
blocking Cloud Run Job, and deploys one revision. That is the entire release
mechanism. Cloud Run waits for the startup probe before moving traffic; a deploy
may briefly interrupt the service, and that is accepted rather than engineered
around.

**Instant migration.** A data migration reaches its final shape in one step. It
never lands a transitional column, a dual-write, or a backfill that a later
release finishes. Migrations are additive where they can be and immediate where
they cannot; a migration that has run anywhere is immutable, because it must
still build a fresh database years later.

**Valid by construction.** An invalid app cannot exist. Every mutation batch is
gated before it commits, identically on the chat SA, the visual builder, and the
MCP API. There is no save/validate/release cycle and no draft state. New
mutations follow the compatibility rules in `lib/doc/CLAUDE.md`: persisted
mutation history must always replay, and when a stored shape changes, the same
change migrates stored history.

**Every wire unit names its fixture.** A unit that emits new wire states the
CommCare suite fixture under
`commcare-hq/corehq/apps/app_manager/tests/data/suite/` that its implementer and
its reviewer assert the emitted bytes against. The bar is "would HQ's importer
accept these bytes", never "does the shape look right", and it applies to tiles,
form links, endpoints, and multi-select alike.

**Every author-facing vocabulary ships its three surfaces.** A unit that adds
something an author can create also ships its SA tools, its MCP projection, and
its public docs — the three editors edit one document, so a vocabulary reachable
from only one of them is an unfinished feature, not a smaller one. Where a
vocabulary is deliberately builder-only, the unit says so and why.

**Nova is not CommCare HQ.** HQ, CommCare Core, Formplayer, and CommCare Android
establish only what the target wire and runtime accept, reject, or execute. Their
authoring models and UI are not Nova requirements, and "HQ does it this way" is
never a design argument. Nova emits one wire flavor: the maximal subset Web Apps
supports, faithfully.

---

## Approved product contracts

These decisions are closed unless the project owner explicitly reopens them.

### Identity and references

- Lookup tables, columns, rows, user types, personas, organization levels,
  locations, operations, sections, links, and endpoints use immutable UUIDs for
  stored identity wherever Nova owns the identity.
- Human names, lookup tags, column wire names, level codes, location site codes,
  and endpoint ids are projections or external contracts, never substitutes for
  internal identity.
- A rename does not rewrite expression text. Printers and emitters resolve the
  current external spelling from immutable identity.
- External-contract names may require confirmation or elevated permission, but a
  rename never silently retargets or deletes a remote resource.

### Users, personas, and workers

- A **user type** is a reusable role/default-data template in the blueprint.
- A **preview persona** is a named design/test actor with stable identity,
  location assignments, and optional user-data overrides. It references a user
  type but is not the type.
- A **deployed worker** is a target-HQ identity associated with one deployment;
  provisioning is the lifecycle action that creates or adopts it. It is created
  from a type or persona, has separate credentials and lifecycle, and is not a
  blueprint identity.
- Preview exposes explicit **Preview as me**, **Preview as persona**, and
  authoring-only hidden-content inspection. These modes must not blend.
- Preview values must be honest. Target-dependent values such as the HQ domain
  slug are absent until a deployment target supplies them; Nova does not invent
  wire values to make a condition pass.

### HQ deployment safety

- Deployment is a dependency graph, not a fixed "app first, warn later" list.
  Required prerequisites are checked before destructive or externally visible
  mutation. A required dependency failure leaves the deployment `incomplete`,
  never ordinary success with a warning.
- A durable deployment record is keyed by Nova app, Project, HQ server, and HQ
  domain. Remote-resource mappings additionally key the Nova resource UUID and
  store ownership/adoption, remote id, pushed identity, and revision.
- Nova never auto-adopts a same-named HQ resource, overwrites an unowned
  resource, or deletes a remote resource on rename. First adoption is explicit.
  Renames create/repoint or update only resources Nova demonstrably owns, and
  report any old remote resource left behind.
- Phases are idempotent and independently retryable. Retrying a table or location
  push must not require importing a duplicate app.
- `uploaded`, `built`, `released`, and `runnable` are distinct states. Endpoint
  links are shown as durable only after their deployment is released and the URL
  has been probed.
- Endpoint URLs derive from the selected HQ server. `lib/commcare/client.ts`
  resolves its base URL per credential server from `COMMCARE_SERVERS`. Two
  suite-emission constants still hardcode the US host and must move to the
  selected server before endpoints ship —
  `lib/commcare/suite/case-search/claim.ts::CLAIM_URL_TEMPLATE` and the search
  template in `lib/commcare/suite/case-search/searchSession.ts`.

### Deliberate target gaps

- **Tile controls that cannot survive HQ upload.** `entitiesPerRow` and
  `uniformCells` are excluded from constructible state: HQ's importer does not
  round-trip them, so an app carrying them would silently lose them on the
  primary delivery path.
- **Case attachment display is link-first.** URL-property mode is the normal
  path. The deprecated `MM_CASE_PROPERTIES` attachment mode is an explicit
  opt-in that works only on a domain carrying HQ's `MM_CASE_PROPERTIES` toggle —
  a target-domain prerequisite recorded in the deployment record and the setup
  artifact, never the default. On a stock domain
  `update_strategy.py::_apply_attachments_action` returns before doing anything,
  so the block parses and is then silently dropped. Inline picture presentation
  is not promised until the Web Apps HTTPS-resource path works.
- **Smart-link authoring does not ship before Nova models data-registry search.**
  No unused emission helper lands as speculative machinery.
- **Long-detail tiles are out of scope.** Tiles apply to the short and
  search details; the case-detail view emits a plain field list.
- **The offline demo sandbox is out of scope.** A `.ccz` can embed a complete
  `<user-restore>`, but Web Apps never boots it — Formplayer installs the
  resource and has no practice-login path, so restores are always live HTTP
  (`OfflineUserRestoreInstaller`). The mechanism is recorded for a future
  mobile-offline story.

---

## Architecture contracts

### One Postgres system

All persistent state uses the Cloud SQL Postgres pool and the Kysely migration
owner.

Lookup definitions and rows are Project-scoped. Organization and persona data are
app-scoped unless a later approved contract says otherwise. Every table has
explicit tenancy keys, authorization, project-move behavior, indexes, migration
ownership, and retention/deletion behavior.

Realtime updates use committed rows plus LISTEN/NOTIFY pokes and cursor/revision
catch-up. Notifications are never the data plane.

Build, migration, and runtime identities are separate. Migration owns fixed
schema objects; the `cases` schema is isolated and runtime-owned because runtime
creates indexes concurrently, which requires table ownership rather than grants.

### Exact external-reference governance

Lookup table/column and location references participate in exact, transactional
reference-edge maintenance. A best-effort scan cannot authorize a destructive
schema change, because it races a concurrent app commit.

The authoritative app commit rebuilds the fresh blueprint and validates it with
fresh Project-scoped external context inside the consistency protocol. Optimistic
client validation may use a revisioned snapshot for fast feedback, but the server
result wins. Missing and foreign-Project resources are indistinguishable and fail
closed for newly introduced references — a differing message would confirm that a
resource exists in a Project the caller cannot see.

Two lock prefixes share one global order. App commits, Project moves, and
reference-edge writes take the app row, then lookup tables in canonical UUID
order, then thread rows. Lookup resource writes — row and definition edits, and
schema governance — never take an app lock at all: their complete prefix is
Project state, then the target table, then the exact edges
(`lib/lookup/schemaGovernance.ts::applyLookupSchemaGovernanceInTransaction`).
Because neither prefix ever holds a lock the other takes first, a table deletion
racing an app commit serializes rather than deadlocking.

### Case operations and submissions

- All expressions for one submission evaluate against a single pre-submission
  snapshot. Effects then apply atomically in declared order.
- Repeated creates have iteration-correlated outputs. A singular operation
  reference cannot escape its repeat or ambiguously name multiple created cases.
- Runtime-resolved targets are tenant-bound and must match the declared case
  type. Client-submitted descriptors are parsed as data, never trusted authority.
- Retype is a real schema transition. It succeeds only when the current
  conversion/parking/data-review model can complete atomically; otherwise the
  operation rejects without partial writes.
- The preview store exposes one atomic submission envelope containing ordinary
  form behavior plus advanced operations. It is not a mutually exclusive fifth
  submission variant.

### Locations and restore scope

Organization structure lives partly in the blueprint and partly in app-scoped
rows, so mutations and row writes share the app-row lock discipline. Removing or
retyping a level, archiving a referenced location, moving an app between
Projects, and adding a reverse-hop expression must account for current rows and
references atomically.

Location custom fields use one app-wide catalog with optional applicable-level
UUIDs. Level codes and site codes are create-once external identities; display
names may change independently.

Restore scope has an authoritative Postgres revision. Client invalidation reuses
the existing case-data invalidation channel; session-local Cloud Run memory is
never the source of truth. Start with the measured CTE inline and materialize
only when measurements justify the storage and invalidation cost.

---

## UX and information architecture

### Design-system authority

Nova generally follows **Google Material 3** for foundations, design tokens,
adaptive layout, interaction states, accessibility, content hierarchy, and
motion. **Apple HIG** supplies platform polish where it improves focus,
keyboard/pointer behavior, touch ergonomics, and motion without contradicting
Material 3, web semantics, or Nova's established visual language.

Precedence for implementation:

1. accessibility, semantic HTML, and valid interaction behavior;
2. the explicit product and UX contract in this document and the active unit;
3. Nova's existing semantic tokens, components, and `components/CLAUDE.md`
   conventions;
4. Material 3 guidance;
5. Apple HIG polish.

This does not mean copying Google's component catalog or Android UI. It means
using the underlying system deliberately: token-driven color/type/shape/spacing;
clear hierarchy and containment; consistent enabled/hover/focus/pressed/dragged
states; adaptive rather than merely scaled layouts; and motion that explains
state or spatial relationship.

### Baseline UI review

- semantic landmarks and sequential headings, logical DOM/focus order, visible
  keyboard focus, focus entry/return for dialogs and route changes, and labels
  that describe purpose rather than icon appearance;
- at least 48 × 48 CSS-pixel touch targets where the mobile layout permits and
  never below a 44 × 44 pointer target, normally separated by at least 8 px;
- text and graphic contrast, text resizing without clipping, RTL-safe ordering,
  and no state conveyed by color alone;
- explicit compact, medium, expanded, large, and extra-large behavior. Material's
  600/840/1200/1600 width boundaries are the review grid; a unit may retain
  Nova's existing breakpoint tokens when it documents equivalent behavior;
- one pane at compact widths, deliberate list-detail or supporting-pane reflow
  where added space improves the task, and more information rather than merely
  larger controls at wide widths;
- complete loading, empty, disabled, stale, conflict, selection, hover, focus,
  pressed, and dragged states using existing semantic tokens; and
- restrained, coherent motion with reduced-motion behavior. Utility transitions
  stay quick; exits are faster than entrances; large expressive transitions are
  exceptional rather than builder-wide decoration.

### Workspace structure

The structure tree represents the runnable app: modules, case-list surfaces,
forms, and eventually their nested structure. Project and app administration does
not masquerade as a child of that tree.

- **Project data** is a URL-owned workspace for Project-shared lookup tables. It
  is reachable from expanded and collapsed desktop navigation and the mobile path
  menu, and it always states that changes affect every referencing app.
- **App setup** is a URL-owned workspace with Users & Personas, Organization,
  Automations, and Deployment sections.
- Configuration workspaces own breadcrumbs, deep links, route recovery, viewer
  mode, focus restoration, mobile layout, and global Preview behavior.
- Destructive or dependency-affecting edits explain consequences before commit.
  Recoverable data edits use inverse-action undo or archive where practical;
  implementation boundaries do not become permanent "No undo" boilerplate.
- Drag/resize/reorder interactions have keyboard and numeric alternatives, stable
  focus, meaningful disabled-drop explanations, and adequate touch targets.
- Empty, loading, stale, conflict, and permission states are acceptance criteria,
  not polish deferred beyond the feature PR.
- Automations do not pretend to execute inside Preview. The UI explains cadence
  and may show a safe read-only "currently matches N cases" evaluation.

---

## What is built

### Lookup tables

Lookup tables are Project-scoped app-state data with stable table, column, and row
UUIDs, typed values, fractional row ordering, raw CSV replacement, exact Postgres
byte accounting, optimistic table revisions, and a Project-wide realtime
invalidation clock. `lib/lookup` is the sole persistence boundary and speaks Nova
vocabulary only; `lib/lookup/CLAUDE.md` is its contract.

Caps are 5,000 rows and 8 MiB per table, measured as exact Postgres bytes rather
than estimated. These bound what a client can be asked to load, which is what
makes client-side choice evaluation viable.

Table schema governance — deleting a table, removing a column, retyping a column —
lives in `lib/lookup/schemaGovernance.ts::applyLookupSchemaGovernanceInTransaction`.
Each requires the `delete` capability and zero applicable reference edges, proved
transactionally rather than by scan. It stays package-private with no user surface
until the Project data workspace owns the confirmation UX.

### Exact reference edges

Every app carries an exact, transactional edge set naming the lookup tables and
columns its blueprint references (`lib/db/lookupReferenceEdges.ts`). Composite
foreign keys make a referenced table undeletable and a referencing app unmovable;
`lib/db/apps.ts::repairLookupReferenceEdges` rederives the set from the committed
blueprint without touching history or the mutation sequence, and
`scripts/scan-lookup-reference-edges.ts` reports mismatches read-only.

Edges are derived state. Any authoritative commit reconciles them completely, so
an unrelated edit to an app with stale edges converges them.

### Display conditions

Modules and forms carry a typed `Predicate` display condition, validated by
`lib/commcare/validator/rules/displayConditions.ts` and emitted through
`lib/commcare/suite/displayConditions.ts`.

The validator's restrictions are wire-forced, not stylistic:

- A relevancy expression that throws at render takes down the **entire** Web Apps
  menu screen, not just the offending item — `MenuLoader::getMenuDisplayables`
  catches and `MenuScreen::init` rethrows at screen level. Every condition is
  therefore boolean by construction and checker-gated.
- HQ rejects any casedb reference in a form filter whose module does not
  guarantee a selected case (`menus.py`, via `xpath_references_case` after
  interpolation). Module filters skip that check but hard-reject `#case`,
  `#parent`, `#host`, **and** bare-dot case shorthand
  (`app_manager/xpath.py::_ensure_no_case_references`), so an emitted module
  filter must be dot-free as well as hashtag-free.
- Counts, `exists`/`missing`, and non-self reads are refused.

The form-condition evaluation locus for a case-first module is the case-list
screen after selection — including suppressing the single-form auto-continue. The
module screen's form list is a gating site only for the forms-first flow, where
the validator already rejects `prop` reads.

Display conditions are UX, not access control: a deep link with
`respect-relevancy="false"` traverses menus and cases that conditions would hide.

### Case operations

Forms carry ordered case operations — create, update, close, with links, renames,
retypes, and owner assignment — validated by
`lib/commcare/validator/rules/caseOperations.ts` and emitted by
`lib/commcare/xform/caseOps.ts`.

Facet legality by action is closed and enforced: `create` requires a new target
and a name and forbids rename/retype; `update` forbids a new target and a name;
`close` forbids a new target, name, owner, rename, retype, **and** links — so
unlinking is always a separate operation from closing, while close may still
carry final property writes.

Reserved case types are `commcare-user`, `commcare-case-claim`, and
`user-owner-mapping-case`. Reserved write properties are
`lib/commcare/constants.ts::RESERVED_CASE_PROPERTIES` — HQ's authoring-side
case-reserved-words list plus `name` and `owner_id` — extended with
`location_id`, `hq_user_id`, `external_id`, `category`, and `state`.

`category` and `state` are reserved because the two runtimes disagree about
them. `case_type`, `case_name`, `owner_id`, `external_id`, `user_id`, and
`date_opened` land in the same dedicated slot on both sides
(`CaseXmlParser::updateCase` and `parser.py::CaseActionBase.V2_PROPERTY_MAPPING`),
but `category` and `state` have dedicated client setters and no server mapping at
all, so the same block sets a reserved slot on the device and an ordinary dynamic
property on HQ. A property that means two different things cannot be authored.

The emitter is total by structural construction, and four wire facts force its
shape:

- A case block with **no** `@case_id` is silently skipped server-side
  (`casexml/apps/case/xform.py::has_case_id` gates `_extract_case_blocks`), so the
  write vanishes with no signal. Guaranteeing `@case_id` structurally is
  mandatory, and the failure mode it prevents is data loss, not an error.
- An index-only block whose own case is locally absent NPEs the client:
  `CaseXmlParser`'s index arm calls `loadCase(errorIfMissing=false)` and
  dereferences unguarded. Pairing every non-create block with an `<update/>` (its
  writes, or an idempotent `case_type`) routes through
  `loadCase(errorIfMissing=true)` and yields a clean readable error instead. An
  empty `<update/>` is a no-op on both runtimes. Attachment-carrying blocks share
  the same null-deref shape and the same guard.
- `<create>` accepts only `case_type`, `case_name`, and `owner_id` children and
  rejects extras, so any additional create-time property write emits in the
  sibling `<update>` of the same block.
- Metadata binds are `@date_modified ← /data/meta/timeEnd` and
  `@user_id ← /data/meta/userID`. The meta block exists post-render on both export
  paths, so source-level binds referencing it are safe.

HQ's render pipeline preserves hand-authored case blocks: `FormBase.render_xform`
wraps the stored source and `xform.py::XForm._create_casexml` only appends
FormActions-driven blocks, with its single collision guard reading the direct
`/data/case` child. Operations therefore ride the XForm source on both export
paths, at nested container paths, never at bare `/data/case`.

Authored case ids follow Vellum's repeat-context split: creates outside a repeat
seed `@case_id` via `<setvalue event="xforms-ready">`, while creates under a
repeat use a bind calculate over the per-instance path. Generated UUIDs take the
setvalue path; authored deterministic keys stay live calculate binds.

An owner expression's result lands verbatim and unvalidated in the case block —
the only server-side check is length ≤ 255. Typed owner addressing is entirely
Nova's guarantee.

### Case identity storage

The whole case-identity family — `cases.case_id`, `cases.parent_case_id`,
`case_indices.{case_id,ancestor_id}`, and `parked_case_values.case_id` — is
`text`, because case ids are opaque CommCare wire identities rather than
intrinsically UUIDs. Nova-generated ids default to `uuidv7()::text`. Because ids
carry no time order, the durable default ordering is `(opened_on, case_id)`
ascending. `lib/case-store/CLAUDE.md` holds the detail;
`scripts/scan-case-id-storage.ts` is the durable read-only pre/post scan for the
family.

Client-side, `CaseXmlParser::parse` and `CaseXmlParserUtil::validateMandatoryProperty`
reject only null/empty, and `case_id` is deliberately absent from
`checkForMaxLength`; HQ bounds it by `CommCareCase.case_id` at 255 characters.

### Lookup carriers, table expressions, and itemsets

Selects take a lookup `optionsSource`, and expressions take `table-lookup` value
terms and `table-column` comparison terms
(`lib/commcare/validator/rules/lookupOptionsSource.ts`, `lib/doc/lookupReferences.ts`).

The local `.ccz` emits the preservable lookup wire. The binding facts:

- A suite-embedded `<fixture>` may sit at any position, requires `id`, stores as
  global when `user_id` is absent, holds exactly one body element, and is
  overwritten on app upgrade (`SuiteParser`, `FixtureXmlParser`).
- `ItemListsProvider` expects the id `item-list:<tag>`, a `<{tag}_list>` wrapper,
  `<{tag}>` rows, and **every** defined field as a child element in definition
  order — an empty element for a missing value. Instances reference
  `jr://fixture/item-list:<tag>` (`generic_fixture_instances`).
- `XFormParser.parseItemset` requires `nodeset` plus `<label ref>` and
  `<value ref>`, and rejects literal items beside an itemset.
- `ItemSetUtils.populateDynamicChoices` resolves the nodeset by declared id, a
  missing one throwing a runtime `XPathException`, and evaluates the predicate
  with `current()` bound to the question node contextualized to the current
  repeat iteration.
- Decimal cells emit exponent-free. Relation tests inside a fixture-row `where`
  anchor on the containing slot's case. `rootCaseId` is honored. An escaped
  column name is a typed rejection (`lookup-row-escaped-column`), never a
  silently mangled emission.

JavaRosa has no XPath-1.0 first-node coercion — a scalar use of a multi-node path
throws (`XPathNodeset::unpack`) — and JavaRosa numeric predicates are **position**
matches, not value matches. First-match lowering therefore carries an explicit
positional `[1]` predicate structurally; coercion will never supply it.

The aggregate embedded-fixture budget is 10,000 rows, 100,000 cells, and 16 MiB of
exact UTF-8 fixture bytes. These are declared Nova policy sized against an
unindexed runtime that materializes XML as object-heavy `TreeElement` nodes; the
cell cap is what bounds that cardinality.

Lookup references execute in the preview but have no wire spelling on the HQ
paths yet, so `lib/export/boundaryValidation.ts` refuses `hq-json` and `hq-upload`
export for a carrier-bearing document (`LOOKUP_CARRIER_EXPORT_NOT_ACTIVE`). Local
`.ccz` export carries them. That refusal lifts when resource push exists.

### Atomic submission and resolved identity

One submission is one transaction. The preview store exposes a single envelope
carrying ordinary form behavior plus advanced operations; the server builds the
`CaseOperationProgram` from the **committed** document, and identity resolves
server-side at the action boundary rather than being folded into a client-supplied
literal. `SubmissionMutation` carries the form UUID plus complete per-scope
operation answer bags as plain JSON — a `Map`, `Set`, or `File` argument would
make React encode multipart, which the edge WAF blocks.

The membership gate precedes the program build, closing a one-bit cross-tenant
survey oracle. An answers-absent document snapshot submits ordinary-only, because
empty bindings would blank-write and a blank projects to key-absent — silent
property deletion.

Wire facts the envelope rests on:

- A `case_type` update rewrites only the type field: no property pruning, no value
  casting (`CaseXmlParser::updateCase`,
  `SqlCaseUpdateStrategy::_apply_update_action` / `::_update_known_properties`).
- `owner_id` is first-class mutable in create and update, with `@user_id` as the
  acting user and the create-time fallback owner; `-` is HQ's
  `UNOWNED_EXTENSION_OWNER_ID`.
- Blocks apply create → update → close → index regardless of child order
  (`parser.py::CaseUpdate`, `xform.py::order_updates`).
- An empty index target removes the link (`CaseXmlParser::indexCase`), and
  create-of-existing merges (`acceptCreateOverwrites` is true in every runtime
  caller).
- Formplayer commits a submission's case blocks together with the HQ POST as one
  transaction (`FormSubmissionHelper::processAndSubmitForm`).
- A default HQ domain performs **no** extension-close cascade: the cascade
  (`submission_post` → `casexml/apps/case/xform.py::close_extension_cases` →
  `get_all_extensions_to_close`) runs only under
  `toggles.EXTENSION_CASES_SYNC_ENABLED`, a frozen per-domain toggle that is off
  by default. The envelope closing only its target case **is** faithful device
  parity, and Nova adds no cascade.

### Preview execution

The running preview executes the blueprint in a client-side engine
(`lib/preview/engine`) over real Postgres case rows. There is no mock mode.

- Display conditions evaluate live (`displayConditionEvaluation.ts`). The preview
  hides conditioned items exactly as a device would, and offers a "hidden items
  (N)" reveal with ghosted entries and a person-readable condition summary. That
  summary printer is display-only and forks no predicate semantics. Authoring
  surfaces — canvas, tree, flipbook — never hide conditioned items.
- Lookup-backed selects render live filtered choices
  (`lib/preview/engine/lookupEvaluation.ts` resolves them,
  `lib/preview/engine/formEngine.ts` materializes them into the running form, and
  `lib/preview/engine/useLookupPreviewData.tsx` holds the builder-session table
  cache). Choice rows hold stable within one form session: a
  row edited mid-entry appears on the next form entry, matching the wire's
  install/upgrade fixture semantic, while the builder-session cache refreshes on
  the Project realtime clock between sessions.
- The AST→Kysely compiler (`lib/case-store/sql`) carries `table-lookup` and
  `table-column` arms, so a lookup-bearing case-list filter compiles to SQL.
- Preview identity is always the signed-in worker until named personas exist.

### Case lists, search, and the case workspace

Every module carries a case-list configuration: one ordered column array carrying
display, sort, calculated, and visibility state together, plus search inputs and
their matching behavior. Predicates are typed ASTs throughout, so a column filter,
a search-input condition, and a display condition all speak the same vocabulary
and all compile to three surfaces — the on-device XPath dialect, CSQL for HQ-side
search, and Postgres for the preview (`lib/case-store/sql`). Search-button display
conditions, results availability, and default ordering are authored in the case
workspace; `content/docs/case-workspace.mdx` is the user-facing guide.

### Media

Assets are Project-scoped: bytes in GCS, a metadata row in Postgres, and
`project_id` set authoritatively at upload as the only access gate. Attach- and
export-time verdicts, the export budget, the wire manifest, and the deletion guard
live in `lib/media`. The manifest filters a document's referenced ids to the
Project, which is also the exfiltration-via-compile defense — a foreign-Project
reference resolves to `MEDIA_ASSET_NOT_FOUND` rather than being emitted. This is
authoring media (menu icons, field images); case-captured media is unit 6.

### Export and HQ upload

`lib/commcare` compiles a `BlueprintDoc` to the wire on three paths: a downloadable
`.ccz`, an HQ import file, and a direct HQ upload through the REST client. All
three re-run the full validator with zero tolerance, and
`lib/export/boundaryValidation.ts` adds the boundary findings that depend on
things the document alone cannot know — Project media membership, and which
carriers a given export mode can represent. Credentials are KMS-encrypted per
server, and `lib/commcare/client.ts` resolves its base URL from the selected one.

### Projects, moves, and multiplayer

Projects are the tenancy and sharing unit: every app carries a `project_id`, every
user has a personal Project, and shared Projects let members co-edit an app plus
its case, media, and lookup data at viewer/editor/admin/owner roles. Invitations
are domain-gated (`lib/projects/invitePolicy.ts`).

Cross-Project moves are live. An admin/owner of both ends moves an app plus its
case, media, and conversation history — including chat-attached files. Media
bytes copy into the destination Project first — content-addressed, so a retry
dedups rather than duplicating — and the blueprint repoint plus every row move
then commit as one transaction, retrying if the app's run holder or media closure
changed underneath (`lib/db/moveAppToProject.ts::runCrossProjectMove`). The
destination picker is an inline radio list over the Projects
where the member also governs placement, because a second floating surface opened
from inside the popover renders beneath it. Governance requires `delete` on both
ends, `deleted_at IS NULL`, owner retention, and an exact empty lookup closure:
an app whose blueprint references lookup tables cannot move, and stored edges that
disagree with the blueprint are themselves a refusal until repaired. Same-Project
case-data recovery is a separate, always-available repair.

Project deletion is globally disabled until Nova has an audited whole-tenant
deletion lifecycle.

### Run holders and the app-write surface

A run holds its app through a server-minted nonce; every claim mints one and every
terminal write compare-and-sets against it exactly. Only `lib/db/apps.ts` and
`lib/db/credits.ts` may issue `apps` DML, and
`lib/db/__tests__/runHolderWriteGuard.test.ts` pins that structurally — a new
writer outside those two files fails the build rather than quietly skipping the
holder proof. Operator recovery (`scripts/recover-app.ts`) delegates to
`recoverAppStatus` behind paired explicit token flags and never writes directly.

Request and run timings are three independently authored fields in
`config/runtime-capabilities.json`; none derives from another.

---

## What remains

Each unit below states its contract, the platform facts that bind it, what a user
observes, and the PR it ships as. A unit with more than one PR names each.

### 1 — Conditions and operations authoring

**PR:** `Author display conditions and case operations in the builder`

Build URL-owned, responsive authoring surfaces for the display-condition and
case-operation vocabulary that already validates, emits, and previews. The
operations stress case is 20 items on one form: default to a list-plus-editor
master/detail model with keyboard reorder and dependency-aware review states. A
configuration URL's global Preview action runs its owning form.

These surfaces live in the existing builder chrome, not a new workspace: the
inspector rail owns per-item settings and the centre canvas owns the full
condition editor, matching where the case workspace already puts a search-button
condition. A `Predicate` is entered through the structured builder; the
`lib/codemirror` XPath editor stays the escape hatch for reading, not the primary
authoring path.

Unit 1's mutation inputs carry no options-source vocabulary — that belongs to
unit 2 — and no SA or MCP surface, which unit 3 owns. Neither is an ordering
constraint: the three units are independent until unit 3 needs both.

**Observed:** an author writes a module or form display condition and a form's
case operations without touching chat, sees the condition's effect in the running
preview, and reorders operations from the keyboard.

**Depends on:** nothing outstanding.

### 2 — Project data tables workspace

**PR:** `Project data workspace: schema, rows, CSV import, and options sources`

Build the Project data workspace: schema and row grid, atomic CSV import,
revisions, conflict handling, permissions, Project switching, and the select
options-source editor. It is reachable from expanded and collapsed desktop
navigation and the mobile path menu, and never appears as an app-content tree
child. It always states that a change affects every referencing app.

This unit also gives `applyLookupSchemaGovernance` its confirmation UX, which is
what lets table deletion, column removal, and column retype leave package-private
scope. Each still requires `delete` plus zero applicable edges.

The one non-obvious semantic is that the source-mode switch is **asymmetric**,
because `optionsSource` precedence is presence-based at every consumer
(`lib/commcare/xform/builder.ts` branches on `optionsSource !== undefined`).
Inline → Table merely sets `optionsSource`, and the inline options stay as the
origin-compatible fallback. Table → Inline must emit an explicit
`optionsSource: null` clear; treating the two directions symmetrically ships a
Table → Inline switch that is observably inert, because the retained source keeps
winning.

**Observed:** an author creates a lookup table, pastes a CSV over it, points a
select at one of its columns, and is told plainly which apps a destructive change
would break before it happens.

**Depends on:** nothing outstanding.

### 3 — SA, MCP, and docs for conditions, operations, and lookups

**PR:** `Expose conditions, operations, and lookups to the SA and MCP`

Expose the display-condition, case-operation, and lookup vocabulary from
[What is built](#what-is-built) through both camelCase chat tools and the
snake_case MCP projection, preserving OpenAI Responses strict-schema
normalization, prompt-cache stability, schema size, and API acceptance —
`lib/agent/CLAUDE.md` holds those constraints, and `scripts/test-schema.ts`
verifies that the generated tool schemas are actually accepted by the API. Update
public authoring docs and every nearest subsystem `CLAUDE.md`. Run one integrated
end-to-end flow:
chat builds an app with a lookup-backed select and a conditional form, the builder
edits it, and the preview runs it.

Two pieces of engineering sit under that packaging, and both are easy to miss.

The **identity bridge**: the SA never sees UUIDs — it addresses modules, forms,
and operations by slug id and fields by path — while the identity contract above
stores them by immutable UUID. Every typed `Predicate` and `ValueExpression` tool
parameter therefore needs SA-facing leaf variants, plus a boundary AST walk that
rewrites them to UUID leaves *before* the checker runs, applied uniformly across
display conditions, operation names and owners, `writes[].value`, form links, and
options-source filters. A leaf that slips through unrewritten fails validation
with a message about an identity the author never typed.

The **null-clears contract**: a tool that cannot distinguish "leave this alone"
from "clear this" cannot express removing a display condition or an options
source, and strict-mode schema normalization makes that distinction non-obvious.
`lib/agent/CLAUDE.md` holds the rule; it is the same asymmetry unit 2 hits in the
builder.

**Observed:** a user can ask for a lookup-backed select in chat and get one, and
can ask for it to be taken away again.

**Depends on:** units 1 and 2.

### 4 — Tile contracts and wire

**PR:** `Case tile layout: identities, validation, and wire emission`

Land stable tile and grouping identities, validation, reference edges, HQ JSON,
suite emission, and oracle fixtures. Author-facing surfaces use Nova relationship
vocabulary, never `parentIndex`.

Binding wire facts:

- A tile detail is an ordinary `<detail>` whose `<field>`s carry
  `<style horz-align vert-align font-size show-border show-shading><grid grid-x
  grid-y grid-width grid-height/></style>`. All four grid attributes are required
  once `<style>` exists — `GridParser::parse` does an unguarded
  `Integer.parseInt` — and a field is a tile cell iff all four are set
  (`DetailField::isCaseTileField`).
- Grouping is a `<group function="string(./index/<id>)" header-rows="N"/>` child of
  `<detail>`. The attribute is `header-rows`
  (`DetailGroupParser.ATTRIBUTE_NAME_HEADER_ROWS`); one CommCare core test fixture
  misspells it `grid-header-rows`, which silently defaults to 1. A grouped list
  additionally needs the companion entry datum
  `<id>_parent_ids = join(' ', distinct-values(…/index/<id>))`, with a `selected()`
  variant for multi-select.
- The group key must be a real case **index**, never a calculated value. The group
  header is the top N rows of the same tile taken from the group's first case, so
  header rows reference parent-case properties (constant across the group) and body
  rows the child's own. You group children by their shared parent index; you cannot
  group parents.
- The 12-column cap (`x + width ≤ 12`) comes from HQ's own parity assertion
  (`test_suite_case_tiles.py::test_case_tile_column_count`), not a core constant —
  commcare-core has no column-count constant and the Web Apps renderer builds
  `repeat(maxWidth, 1fr)` from the actual extent. Nova enforces 12 itself.
- Nova always emits HQ's `custom` tile vocabulary (`case_tile_template = "custom"`
  plus per-column grid fields) and never the named templates `person_simple` or
  `icon_text_grid`. Layout presets are builder gestures that fill per-column
  placement, never persisted template slugs. This sidesteps `person_simple`'s
  legacy hardcoded profile image and register action, and HQ's slot-mapping
  validators, and keeps one wire path for presets and hand layouts.
- Search-result lists inherit tiles automatically: `Module.search_detail()`
  deep-copies the short/long detail, so one Nova config already drives the case
  list, the search results, and the persistent tile.
- HQ's suite regeneration of tiles is **not** toggle-gated — `details.py` fires
  `CaseTileHelper` purely on `detail.case_tile_template` being set. An uploaded
  Nova tile config emits fully on any domain with no setup-artifact prerequisite.
  Grouping needs CommCare ≥ 2.54 on the client, which the Web Apps target gives.

**Observed:** nothing yet — this unit is wire and validation only.

This is the one split where emission lands before its authoring surface, and it
does not contradict the no-speculative-machinery rule: the consumer ships in the
same PR. The oracle fixtures are that consumer, and the bar is the standing one —
every emitted byte is asserted against the CommCare tile fixtures —
`suite/suite-case-tiles.xml`, `suite/case_tile_template_format.xml`, and
`suite/case-tile-case-detail.xml` under
`commcare-hq/corehq/apps/app_manager/tests/data/` — so the question answered is
"would HQ's importer accept these bytes", not "does the shape look right".
Smart links are excluded elsewhere precisely because they would have *no*
consumer at all.

**Depends on:** nothing outstanding.

### 5 — Tile query, preview, and authoring

**PR:** `Case tile query layer, preview rendering, and layout authoring`

Add group-aware ordering and pagination **at the data layer** before rendering.
Groups cannot be formed after a 50-row page is fetched: grouped lists are
re-sorted by first-appearance order of the group key after the user sort and
before pagination (`EntityScreenHelper::groupEntities` performs a stable
clustering sort), and pagination then counts group boundaries on adjacent keys
(`EntityListResponse::getEntitiesForCurrentPage`). A grouped list pages by group,
not by row, and Nova's preview and query layers apply the same clustering
re-sort — including for a user sort that does not cluster by the parent index.

Web Apps tile rendering is fully specified in source and is the parity target:
Formplayer serializes `Tile[]` grid coordinates plus `Style[]`,
`usesCaseTiles`/`maxWidth`/`maxHeight`/`numEntitiesPerRow`/`useUniformUnits`/`groupHeaderRows`,
and a per-entity `groupKey`; cloudcare converts coordinates to 1-based CSS
`grid-area` (`views.js::getGridAttributes`), builds the container grid via
`buildCellGridStyle`, splits header from body fields by `gridY < groupHeaderRows`,
and renders the persistent tile sticky above forms (`PersistentCaseTileView`,
suppressed in App Preview only).

Define pager semantics, persistent-tile locations, presets, responsive rendering,
keyboard and numeric layout alternatives, and one visual parity journey.

Because `entitiesPerRow` and `uniformCells` are excluded from constructible state,
the parity renderer must pin what it assumes in their absence — the runtime
defaults, one tile per row and non-uniform units — and the parity journey asserts
against those values rather than leaving them implicit.

**Observed:** an author lays out a case tile on a grid, groups a child list by its
parent, and sees the same layout in the running preview that a device would show.

**Depends on:** unit 4.

### 6 — Capture, storage, and submission lifecycle

**PR:** `Media capture in forms: staged upload, lifecycle, and case references`

Implement real image, audio, video, and signature capture, and decide generic-file
scope explicitly before implementation starts. Media capture in a Web Apps form
works end to end; the platform caps are 4 MB per file, 50 files, and a 5 MB
request (`MediaValidator.kt`, Formplayer `application.properties`).

Specify staged upload, cancellation, retry, required/relevant behavior, repeat
support, compensation and orphan cleanup, authorization, case-reference deletion
guards, and why case captures do not pollute the authoring media library.

The `MEDIA_CASE_PROPERTY` validator rule
(`lib/commcare/validator/rules/form.ts::mediaCaseProperty`) currently rejects
media capture kinds carrying `case_property_on`. This unit lifts that rejection
for exactly the save-to-case shapes and keeps it for a media kind with
`case_property_on` and no mode.

Lifting it makes save-to-case constructible one unit before unit 7 can emit it,
which would otherwise mean an author ticks "save to the case" and every export
silently emits nothing — the failure mode the total-emitter contract exists to
prevent. So this unit also lands the export boundary finding that says so, beside
`LOOKUP_CARRIER_EXPORT_NOT_ACTIVE` in `lib/export/boundaryValidation.ts`, and unit
7 removes it. Naming the refusal is the whole point: a person who cannot export
must be told which field is holding it back.

**Observed:** a worker photographs something in a preview form and the image
survives submission, appears against the case, and can be replaced or removed.

**Depends on:** nothing outstanding.

### 7 — Attachment target-aware emission and link UX

**PR:** `Attachment URL columns, link presentation, and the opt-in legacy attachment mode`

Add target-aware URL-property emission only when the deployment server and domain
are known, explicit link presentation, preview replacement and removal, SA and
docs coverage, and the deprecated attachment compatibility path — offered only
when the deployment record shows the target domain carries HQ's
`MM_CASE_PROPERTIES` toggle, and stated in the field UI before selection.

Binding facts:

- Web Apps **never** displays a case-persisted attachment in-app: Formplayer's
  `processCaseAttachment` hooks are no-ops, the reference is never stored locally,
  there is no serving path, and restore emission sits behind the deprecated flag.
  Attachment mode's only display surfaces are the HQ case page and Android.
- The machine-readable bytes endpoint is
  `GET /a/<domain>/api/form_attachment/v1/<instance_id>/<attachment_id>` (url name
  `api_form_attachment`), a `StreamingHttpResponse` with the attachment's MIME
  type, HQ-session-gated. The reports route
  `form_data/<instance_id>/attachment/<attachment_id>` is a **human HTML viewer
  page** and must never be targeted from an image or link column.
- `detail_screen.py::Picture` is the correct wire format for an image-valued
  column once the cloudcare HTTPS passthrough is fixed. Until then the
  plain/markdown column formats render the stored URL as a clickable link, which
  is the working link-first path. Do not default to a broken HTTPS picture column.

The emitted value is a calculate over the submission's own metadata —
`concat('<origin>/a/<domain>/api/form_attachment/v1/', /data/meta/instanceID, '/',
'<attachment name>')` — so `instance_id` comes from the form instance and the
attachment name from the capture field. Both halves of the origin come from the
deployment record, which is why this unit waits on unit 12. A local `.ccz` export
has no origin or domain to resolve, so it emits the field without the URL column
and says so at export time rather than writing a URL that resolves nowhere.
- An empty `<attachment>` element removes a case attachment on both runtimes.

**Observed:** a case list shows a working link to a captured photo, and an author
is told plainly why inline display is not offered.

**Depends on:** unit 6, and the deployment target from unit 12.

### 8 — User types and preview personas

**PR:** `User types and preview personas as first-class blueprint objects`

Persist separate user-type and persona collections through normalized blueprint
rows and durable mutation history. Define persona deletion and usercase lifecycle
before implementation.

Binding facts:

- HQ's custom user-data schema is one `CustomDataFieldsDefinition` per
  `(domain, field_type)`; mobile and web users share `field_type='UserFields'` and
  are split only by per-field `required_for`. A `Field` is
  `{slug ≤ 127, label, is_required, required_for, choices, regex, regex_msg,
  upstream_id}`, and regex enforcement is behind the paid
  `REGEX_FIELD_VALIDATION` privilege.
- Slug legality is the Django slug charset (letters, digits, `_`, `-`), at least
  one non-digit, not in `SYSTEM_FIELDS` (`name`, `type`, `owner_id`, `external_id`,
  `hq_user_id`, `user_type`, `commtrack-supply-point`), and never prefixed
  `commcare` or `xml` (`XmlSlugField`, `validate_reserved_words`). Nova enforces
  this exact rule at construction so a push can never fail on identity grounds.
- The restore's `<Registration><user_data>` block injects framework keys **after**
  authored data, so they win collisions: `commcare_project`,
  `commcare_first_name`/`_last_name`/`_phone_number`, `commcare_user_type`,
  `commcare_profile`, `commcare_location_id`, `commcare_location_ids`,
  `commcare_primary_case_sharing_id`, plus `user_type='demo'` for practice users.
  That injected set **is** the built-in user-property catalog and the reserved-name
  list — no separate source is needed.
- Only three keys are read by the runtime framework: `user_type` (demo
  detection), `commcare_project`, and `commcare_location_ids` (a location change
  triggers a local case purge). Everything else in `session/user/data` is inert.
- The client's registration parser writes every `<data key>` into
  `User.properties` verbatim — no key restrictions, last-wins on duplicates — and
  incremental restores merge without clearing, so a key deleted on HQ lingers on
  the device until a full resync. Nova documents this staleness rather than
  simulating it.
- `CustomDataFieldsProfile` is behind the paid `APP_USER_PROFILES` privilege and
  is deliberately **not** Nova's provisioning model; a Nova user type compiles to
  plain per-user `user_data` values.
- Ordinary workers must not receive demo-only `user_type`, and `commcare_project`
  stays absent without a target domain.

**Observed:** an author defines "CHW" once, previews the app as a persona holding
that type, and sees conditions on `session/user/data` behave.

**Depends on:** nothing outstanding.

### 9 — Organization model and locations store

**PR:** `Organization levels, the app-scoped locations store, and owner validation`

Land the app-wide custom-field catalog, stable level and site codes, app-scoped
location rows, realtime revisions, cross-store lock discipline, row integrity,
archive and reassignment rules, Project-move handling, and role-aware owner
validation. The model validates whether a fixed destination can belong to each
applicable persona's address-book footprint; unit 10 proves the emitted fixture
actually carries it.

Binding facts:

- `SQLLocation.location_id` is a server-generated `uuid4().hex`, globally unique,
  and is the **ownership** identity; `site_code` is domain-unique, mutable, and
  auto-derived, and is the human/bulk identity. Custom-field values live in a plain
  metadata JSON blob while definitions use the same `custom_data_fields` machinery
  under `field_type='LocationFields'`. There is no `LocationFixtureDataField`
  model.
The flags below are HQ's storage, not Nova's authoring vocabulary. They fall into
two independent axes, and conflating them is the classic authoring error:
`shares_cases`, `view_descendants`, and `expand_view_child_data_to` shape **case
flow** — which cases a worker receives — while `expand_from`, `expand_from_root`,
`expand_to`, `include_without_expanding`, and `include_only` shape **fixture
contents** only — which locations a worker can see and address. A level that owns
cases and a level that is merely referenceable are different authoring choices,
and Nova names them as such rather than exposing eight booleans.

- `LocationType` flags, per column: `code` (SlugField, auto-derived, domain-unique
  — the fixture `@type`), `shares_cases`, `view_descendants`, `has_users`
  (default true; editing it is toggle-gated), `expand_view_child_data_to` (same
  gate), the fixture-scope flags
  (`expand_from`/`expand_from_root`/`expand_to`/`include_without_expanding`/`include_only`),
  and `administrative` — which is forced true on non-CommTrack domains and is
  therefore **not** a usable "owns nothing" inverse. `has_user` is dead.
- Owner-set assembly: owner ids are the user id plus one id per case-sharing
  group, where each case-owning location materializes as an `UnsavableGroup` whose
  `_id` **is** the `location_id`. Case-owning is two filtered sets, and the
  descendant filter is easy to drop and wrong to drop
  (`models.py::CouchUser::_get_case_owning_locations`): the user's assigned
  locations whose *type* carries `shares_cases`, **plus** the descendants of
  assigned locations whose type carries `view_descendants`, themselves filtered to
  `shares_cases` **and** not archived. Omitting either filter puts non-sharing or
  archived locations in the owner set and the persona sees cases a real worker
  never would. Web users get location groups only, never classic groups.
- Unassigning the last worker from a case-owning location merely **orphans** its
  cases — `owner_id` keeps pointing at the location and nothing moves. HQ's
  "Orphan Case Alerts" setting is a UI warning only. This is validator and SA
  guidance material, never mechanics.
- Location-scoped web permissions (`location_safe`, `access_all_locations`) are an
  HQ-console authorization axis with no wire representation — nothing to model or
  emit.

**Observed:** an author builds a district/facility hierarchy, assigns a persona to
a facility, and is warned before archiving a location that owns cases.

**Depends on:** unit 8.

### 10 — Usercase, owner sets, restore scope, and wire

**PR:** `Usercase materialization, owner sets, restore closure, and the location fixture`

Materialize persona usercases without clobbering app-authored fields; derive owner
sets; run tenant-complete restore closure; lower user and location terms; and emit
the flat location fixture and usercase actions. Start with the measured CTE inline
and Postgres revision invalidation, and re-run current-scale measurements before
choosing materialization.

**The restore closure is a fixpoint, not a filter**, and it is the hardest part of
this unit. Ownership alone does not decide what a device holds; extension chains
pull cases in that nobody owns. The rules, verified in
`casexml/apps/phone/data_providers/case/livequery.py::do_livequery`:

- A case is **available** if it is open and not an extension case, or open and the
  extension of an available case. A case that is both a child and an extension
  counts as *not* an extension, so it is available on the first arm.
- A case is **live** if it is owned and available. An owned open extension is
  never seeded directly — it becomes live only once its host chain is available.
- Liveness then **propagates transitively** through three edge kinds at once
  (`enliven`): a live case makes its extensions, its hosts, and its parents live.
  So an unowned parent arrives because its child is owned, and an unowned host
  arrives because its extension is.

Preview must reproduce this fixpoint rather than approximate it with a join —
this is the mechanism behind the soft-close doctrine in
`docs/research/advanced-case-actions.md`, where hard-closing a root silently drops
its whole extension tree from every device. Acceptance runs the closure against
seeded chains that are unowned-but-reachable and owned-but-unreachable in both
directions.

Binding facts:

- **Emit only the flat location fixture.** The hierarchical `commtrack:locations`
  fixture is gated by `HIERARCHICAL_LOCATION_FIXTURE`, which is deprecated; the
  flat fixture is default-on for locations-enabled domains; and no "Sync All
  Locations" toggle exists (`INCLUDE_ALL_LOCATIONS` is unrelated conditional-alert
  targeting).
- Flat fixture byte contract: `<fixture id="locations" user_id indexed="true">`
  wrapping `<locations>` of flat `<location>` elements with attributes `type` (the
  level code), `id`, and one `{level_code}_id` lineage attribute per level (self
  plus each ancestor's id, empty string otherwise); built-in children `name`,
  `site_code`, `external_id`, `latitude`, `longitude`, `location_type`, and
  `supply_point_id` (string-coerced, empty when unset); custom fields as
  grandchildren under exactly **one** `<location_data>` child (every defined field,
  empty text when unset); and an index-schema node over `@{code}_id` per level plus
  `@id`, `@type`, and `name`. Custom fields are not indexed.
- **Cross-level addressing joins on HQ's built-in `{code}_id` lineage attributes,
  not on custom fields.** Custom location data is always `<location_data>`
  children, never attributes. The indexed `data_<slug>` shape appearing in two
  orphaned HQ test files is a removed feature (`index_in_fixture`) — do not build
  to it.
- Location-fixture **scope is a footprint, not the whole tree**: a recursive SQL
  CTE over assigned locations plus ancestors, with the expand/include flags encoded
  as depth rules (`include_without_expanding` = all of a level plus ancestors;
  `include_only` = a type filter; ancestors always included un-expanded).
- The restore's user-groups fixture carries location groups verbatim as
  `<group id="{location_id}">`, and the client builds its owner set **exclusively**
  from user ids plus that fixture (`UserGroupsFixtureProvider`,
  `SandboxUtils::extractEntityOwners`). That pair is the exact formula a faithful
  preview owner set reproduces.
- The usercase is HQ-gated by the paid `USERCASE` privilege. Rows sync on user save
  with case type `commcare-user`, `hq_user_id` = the user id, `external_id` = the
  user id, and owner = the user's own id. Nova cannot see a target domain's plan,
  so authoring stays ungated and the plan requirement travels as an export note.
- Usercase wire shape: `usercase_update`/`usercase_preload` emit a case block at
  `/data/commcare_usercase/case` whose `case/@case_id` binds to
  `instance('commcaresession')/session/data/usercase_id`, and the suite adds a
  computed `SessionDatum(id='usercase_id', function=UsercaseXPath().case()/@case_id,
  requires_selection=False)` plus a count-equals-1 assertion keyed
  `case_autoload.usercase.case_missing`.
- Client-side the usercase is an ordinary case — there is zero `commcare-user`
  special-casing in commcare-core or Formplayer and nothing blocks create or close.
  Any create/close prohibition is Nova's own authoring guard matching HQ's
  authoring-side rule, not a runtime constraint.

One delivery precondition is easy to miss and silently breaks the whole fixture:
a form only carries the `locations` instance if something in it **references**
that instance. HQ authors work around this with a dummy always-false question —
exactly the hidden scaffolding Nova must never make an author think about — so
Nova's emitter adds the declaration whenever a location term appears anywhere in
the form. The general rule governing any fixture family: `instance('X')` binds a
declared `<instance id="X" src="jr://fixture/Y">`, and `Y` — the substring after
the last `/` — must equal the delivered fixture's id
(`CommCareInstanceInitializer::loadFixtureRoot`). A mismatched pair resolves to
nothing at runtime with no build-time error.

Acceptance includes proving that every valid fixed or reverse-hop destination is
present in the applicable persona's emitted fixture, that an out-of-footprint
destination is rejected before commit, and that a form carrying a location term
emits its instance declaration without any authored placeholder.

**Observed:** previewing as a persona shows exactly the cases that persona's
worker would see on a device.

**Depends on:** unit 9.

### 11 — Representable automations and setup guidance

**PR:** `Automations as blueprint objects with a regenerated HQ setup artifact`

Define exact automation schemas. Keep only HQ-representable criteria, actions, and
schedules, and render setup guidance with current plan-tier, cadence, and cap
facts. Preview may calculate current matches but must never imply the scheduled
automation executes locally.

Binding facts:

- Rules and conditional alerts are **one** HQ model: `AutomaticUpdateRule` with
  workflow in `{CASE_UPDATE, SCHEDULING, DEDUPLICATE}`. An alert is the
  `SCHEDULING` arm carrying a `CreateScheduleInstanceActionDefinition`, and the
  criteria engine is shared across both.
- The criteria vocabulary is closed: `MatchPropertyDefinition` with nine match
  types (`EQUAL`, `NOT_EQUAL`, `HAS_VALUE`, `HAS_NO_VALUE`, `REGEX`, and four
  date-offset comparisons against `case_date + N`), plus `ClosedParentDefinition`,
  `LocationFilterDefinition`, `UCRFilterDefinition`, and code-registered customs;
  `criteria_operator` is `ALL` or `ANY`; `filter_on_server_modified` with
  `server_modified_boundary` adds an implicit server-modified-age criterion; closed
  cases are skipped. The `CASE_UPDATE` action vocabulary is equally closed:
  `UpdateCaseDefinition` sets properties to a literal or another case property's
  value (including `parent/` and `host/` ancestor writes) and/or closes the case.
- Cadence and cap: an hourly task processes each domain **once daily** at its
  `auto_case_update_hour` (default midnight UTC), with an on-save path behind a
  toggle. `MAX_RULE_UPDATES_IN_ONE_RUN` is **10,000** per
  `(domain, case_type, db-partition)` run, per-domain overridable via
  `Domain.auto_case_update_limit`; hitting it halts the run with a notification and
  re-sweeps the next day. **The widely cited "50,000/day" figure is the unrelated
  outbound-SMS daily limit** — do not repeat it in guidance.
- Alert recipients are a closed vocabulary: generic (Location, Group, users, case
  group) plus case-relative (Self, Owner, LastSubmittingUser, ParentCase,
  AllChildCases, CasePropertyUsername/UserId/Email) plus code-registered customs
  listed in `AVAILABLE_CUSTOM_SCHEDULING_RECIPIENTS`. Customs are instance
  configuration — a domain picks from what its HQ ships and can never author new
  ones, so a self-hosted HQ may lack them.
- Content types are SMS, Email (subject/message/html), SMS survey, IVR/callback,
  Connect, and custom. **There is no push-notification type.** Message templating
  exposes every case property as `{case.<prop>}` plus `{case.owner.*}`,
  `{case.parent.*}`, `{case.host.*}`, and `{recipient.*}`.
  `Schedule.user_data_filter` evaluates against custom user data, or the usercase
  via `use_user_case_for_filter`.
- Plan tiers differ per arm: case-update rules require `DATA_CLEANUP` (Pro+),
  conditional alerts require `REMINDERS_FRAMEWORK` (Standard+), and SMS delivery
  additionally requires `OUTBOUND_SMS` at send time — so an email-only alert needs
  neither SMS privilege nor Pro. A per-domain kill switch also exists.
- **The API gap is real and re-verified:** there is zero REST surface for rules,
  alerts, or schedules — no resources in any API version, HTML views only, the one
  messaging API is read-only history, and there is no in-flight scaffolding. The
  only bulk path is the UI-gated conditional-alert Excel upload. Automations
  therefore ship as a human-applied setup artifact behind a push port, which is why
  they are a **third** artifact family alongside the user-data schema and the org
  model.
- The canonical claim-cleanup sweep needs **zero** criteria rows:
  `case_type='commcare-case-claim'` with `filter_on_server_modified=True`,
  `server_modified_boundary=N`, and `UpdateCaseDefinition(close_case=True)`. The
  caveat travels with it: the boundary measures server-modified age, not claimed-at
  age; a claimed-at variant needs an explicit date-offset criterion.

Not every criterion in that closed vocabulary can back the "currently matches N
cases" count, because the count runs through the AST→Kysely compiler over Nova's
own case rows. Nova makes constructible exactly the criteria it can evaluate
locally: the nine `MatchPropertyDefinition` match types, `ClosedParentDefinition`,
and — once unit 9 lands its rows — `LocationFilterDefinition`. `UCRFilterDefinition`
references a report config Nova does not model, code-registered customs vary per
HQ instance, and `filter_on_server_modified` measures HQ server-modified age,
which has no local counterpart. Those three stay setup-artifact-only: authorable
as artifact text, excluded from the constructible schema. A rule mixing both kinds
shows its count over the evaluable criteria and states plainly which criterion the
count could not include — a silent under- or over-count is worse than no count.

**Observed:** an author declares a cleanup rule, sees how many cases it currently
matches, and receives copy-pasteable HQ setup steps rather than a false promise of
execution.

**Depends on:** unit 9 (location criteria) and unit 8 (user-data filters).

### 12 — Deployment core and artifact

**PR:** `Durable deployment records, ownership mappings, and the setup artifact`

Create durable deployment and resource mappings, state transitions, preflight,
ownership and adoption, independently retryable phases, the target-aware setup
artifact, and release/probe state. Establish the current upload lifecycle before
endpoint URLs or dependent drivers consume it.

The setup artifact is the regenerated, human-applied half of deployment: the user-
data field schema, the organization model (level definitions are UI-only — see
unit 13), and automations. It regenerates from the document on every export behind
a push port.

The state machine is this unit's core deliverable, so it is enumerated here rather
than discovered later. A deployment is `preflight` while prerequisites are being
checked, `uploaded` once the app JSON lands, `built` once HQ has produced a build,
`released` once that build is released, and `runnable` once a released endpoint
URL has been probed. `incomplete` is the terminal refusal: any required phase that
fails lands there and withholds both `released` and `runnable`, and it is reached
from any earlier state. Every phase is independently retryable from the state it
failed in, and retrying never requires re-importing the app.

Existing export guards stay until unit 13 can satisfy them: you cannot upload an
app that references a resource you have not pushed.

**Observed:** an author connects an HQ domain, sees exactly what Nova will create
there and what they must set up by hand, and can retry a failed phase without
re-importing the app.

**Depends on:** units 8, 9, and 11 for artifact content.

### 13 — Push and provisioning drivers

**PR:** `Push referenced lookup tables and locations, and provision workers`

Implement referenced-table push, location push, and explicit worker provisioning
against the ownership mappings from unit 12. Preflight organization levels,
fields, and toggles before external mutation. Push and verify required tables and
locations before app import or release where the target APIs permit. If an
unavoidable required step can occur only after import, its failure leaves the
deployment explicitly `incomplete` and withholds `released` and `runnable`. Never
store plaintext credentials. Specify username conflict, temporary secret,
update/adoption, archive, and partial-failure behavior.

Lift the HQ export guards — including `LOOKUP_CARRIER_EXPORT_NOT_ACTIVE` — only
when required resources and ordering are verified end to end.

Binding facts:

- **Lookup tables.** JSON REST `lookup_table` (list GET/POST, detail
  GET/PUT/DELETE; **tag is immutable on PUT**, duplicate-tag POST → 400) plus
  `lookup_table_item` (row identity is UUID-only with no natural key; `sort_key`
  auto-increments on POST). Because rows have no content key, a JSON-REST row sync
  would force Nova to keep per-row remote-UUID bookkeeping — so the Excel bulk POST
  `/a/<domain>/fixtures/fixapi/` is the row path: API-key auth,
  `replace=true|false` (full replace vs merge), sync or async with a `download_id`
  and pollable `status_url`, hard-capped at `MAX_FIXTURE_ROWS` = 500,000 rows
  per workbook (`fixtures/upload/const.py`) — far above Nova's own 5,000-row
  table cap, so a legal Nova table never needs chunking across workbooks.
- **The fixapi workbook format is not "one sheet with field-name headers".** It is
  a mandatory `types` definition sheet (one row per table: `Delete(Y/N)`, the table
  tag, the global flag, and the field-name columns) **plus one data sheet per table
  named by its tag**, whose headers are `UID`, `Delete(Y/N)`, and `field: <name>`
  (colon syntax) per column. `UID` is left empty on insert and is what merges key
  on. A workbook missing the types sheet is rejected outright (`no_types_sheet`).
  SheetJS `xlsx` is already a dependency; no second spreadsheet writer is needed.
- **A tag rename must use an explicitly preflighted replacement/adoption workflow,
  never an in-place REST PUT**, because the detail PUT rejects an established tag
  change even though the storage model and legacy UI can rename it. Do not route
  through the legacy Manage Tables endpoint, whose tag-length check is narrower
  than HQ's 32-character model/API bound.
- **Locations.** v0.6 `LocationResource` is writable: list GET/POST/PATCH, where
  `patch_list` is atomic and capped at `patch_limit = 100` per request, upserting
  (an item with `location_id` updates, otherwise creates), plus detail GET/PUT.
  Create requires `name` and `location_type_code`; the parent is given as
  `parent_location_id` (an HQ `location_id`, hence strict parent-before-child
  ordering); `site_code` is settable, domain-unique-validated, and auto-derived when
  omitted; `location_data` is validated against the domain's `LocationFields`
  definition and unknown keys raise `LocationAPIError`. All location APIs require
  the paid `LOCATIONS` privilege, and v0.6 exposes active locations but no archive
  or delete method.
- **The org model itself is not pushable.** `LocationTypeResource` has no
  authorization override and falls back to tastypie `ReadOnlyAuthorization`, so
  level definitions are UI-only and ship in the setup artifact while the tree
  pushes via v0.6.
- **Users.** `CommCareUserResource` list GET/POST (username is create-only,
  normalized through `generate_mobile_username` and immutable afterwards; a
  password is required at create unless the domain has
  `TWO_STAGE_MOBILE_WORKER_ACCOUNT_CREATION`), detail GET/PUT (`user_data` flows
  through the system-key-guarded `UserData.update`), DELETE = soft retire.
  `primary_location` and `locations` must be supplied **together**, the primary
  must be in the list, and every id is verified against active locations. Identity
  is the server-assigned `user_id` — the durable key the usercase and session keys
  ride on. Web users come in via `InvitationResource` POST, which resolves `role`
  by **name** against the domain's roles and fails without one, so a Nova user type
  cannot supply it. No REST resource exists for the user-data field schema.

**Observed:** an author pushes an app whose selects are backed by a Project lookup
table, and the table exists on HQ before the app that references it.

**Depends on:** unit 12.

### 14 — App setup UI, SA, MCP, and docs

**PR:** `App setup workspace: users, organization, automations, and deployment`

Build the URL-owned Users & Personas, Organization, Automations, and Deployment
sections with responsive navigation, permissions, conflict and recovery states,
deployment progress and retry, and honest target prerequisites. Complete the SA
and MCP tools, the public docs, and the cross-facility owner/restore walkthrough
scenario.

**Observed:** everything from units 8–13 is reachable without chat.

**Depends on:** units 8–13.

### 15 — Exclusive form links and sections

**PRs:**
1. `Durable form-link identity and exclusive link projection`
2. `Form sections with fractional order`

Fix the existing "first matching link wins" wire bug and reject links after an
unconditional branch. A terminal unconditional link is the exhaustive `else`: its
emitted guard is the negation of every prior condition, it suppresses the
`postSubmit` fallback, and the form is valid without a separate `postSubmit`
target. An expression that prints to empty XPath is unconditional. One shared
projector owns these guards for local suite emission and the HQ JSON expander, and
tests cover both paths.

Links gain durable UUID and order identity in **one** release — no legacy
array-order bridge. Confirm current production carries no form links immediately
before the identity change commits; if that is ever nonzero, the same migration
converts current entities and accepted history together, in one step.

Then add form sections with fractional order and history-compatible mutations.
Define relevance skipping, Next/Back validation, earliest-invalid Submit routing,
mutation re-anchoring, preview persistence, and accessibility before UI
implementation.

Binding facts:

- Form links emit one `<create if="…">` frame per link with **first-true-wins**
  semantics, plus a fallback frame guarded by `and(not(c1), not(c2)…)`. HQ's
  `WORKFLOW_FALLBACK_OPTIONS` is `None` — a latent HQ bug — so Nova validates its
  own fallback destination.
- All six end-of-form workflows map 1:1 onto Nova's `postSubmit`
  (`app_home ↔ default`). `WORKFLOW_DEFAULT` emits **no** `<stack>` at all —
  absence *is* the runtime's built-in return; `root` emits an empty `<create>`
  (`allow_empty_frame`); `module` is **parent-aware**
  (`_frame_children_for_module` first recurses into `module.root_module` and then
  appends the module's own command, because a one-command frame naming a nested
  submenu is unreplayable — the runtime offers a submenu only where
  `currentMenuId == menu.root`, and an unmatched frame step strands the user at the
  root menu); `parent_module` recurses the root module's frame children; and
  `previous_screen` is the nav chain minus its last datum, which HQ's own docstring
  calls "the most fragile".
- The stack vocabulary is closed: operations `{create, push, clear}` each with an
  optional `@if`, and steps `{datum, instance-datum, command, query, mark, rewind,
  jump}`. Datum values are evaluated **at push time** — concrete strings, never
  lazy references — and `rewind` truncates to the latest mark, is silently ignored
  when there is no mark, and halts every further operation.
- **There is no wire notion of sections, steps, or pages** — only the XForms
  `<group>`, with `appearance="field-list"` rendering multiple questions on one
  screen. Verified by negative sweeps across `xml_models.py`, `models.py::FormBase`,
  and `xform.py`. Sections are a Nova-only projection that compiles away to
  `<group appearance="field-list">`.
- **Design fence: a section carries no expression slots, ever.** The moment a
  section wants a condition or repetition it is a group or repeat and must be
  authored as one. The fence is structural — the schema has no such slots — and
  stays that way.
- Sections beat multi-form chains, and the reason is verified mechanics rather
  than preference. Web Apps navigation is a stateless client-held selections array
  replayed from a reset session (back = truncate + full replay); a pending chained
  frame is wiped **wholesale** when a re-selected datum diverges from its snapshot
  (`SessionFrame::isSnapshotIncompatible` → `removeAllElements`); there is no
  lease, timestamp, or rollback primitive anywhere in the frame machinery, only a
  7-day session purge. A closed tab permanently strands mid-flow case writes.
  There is also no interactive datum re-prompt during chaining: the stack op must
  name every needed datum and the carried case must still sit in the target entry's
  nodeset, or the runtime logs a reconstruction failure and strands the user.
  Auto-select rescues only opt-in single-match datums.

**Observed:** an author routes a worker to different follow-up forms by condition
and gets an honest exhaustive `else`; long forms break into sections that page
predictably.

**Depends on:** nothing outstanding.

### 16 — Nested menus and linked-form reuse

**PR:** `One-tier menu nesting and native linked-form reuse`

Add one-tier nesting, ancestor-aware session context, tree and breadcrumb
behavior, display-condition inheritance, delete and cycle rules, and linked-form
identity. Before freezing the projection, pin an HQ import plus Make New Version
round trip for the shadow shape. A host module must remain valid native content; a
linked-only empty ordinary module is not allowed.

Binding facts:

- `root_module_id` emits as `<menu id="m<child>" root="m<parent>">`. `put_in_root`
  instead **collapses** the child's menu id into the parent's — same-id `<menu>`
  elements concatenate their commands — while AND-merging the parent's
  `module_filter` into the flattened child's relevancy. The platform supports
  effectively one nesting tier. Training modules use the reserved root
  `training-root`.
- **Shadow modules are wire-level duplication, not reference.** A shadow emits its
  own `<entry>` per source form with the **same** form xmlns and shadow-scoped
  command ids `m<shadowIdx>-f<n>`, plus its own menu, details, and filter. v2 is
  current and v1 deprecated, and `APP_BUILDER_SHADOW_MODULES` gates HQ's
  **authoring UI**, not the wire — so Nova emits the same shape from a plain
  native reference with no shadow authoring objects and no domain toggle.

**Observed:** an author groups modules under a parent menu and reuses one form
from two places without duplicating its content.

**Depends on:** unit 15.

### 17 — Session endpoints and deep links

**PR:** `Session endpoints and shareable deep links`

Verify claim-command resolution against current HQ fixtures **first** — the claim
push is the part most likely to have drifted, and the emitted frames are asserted
against `session_endpoint_remote_request.xml` and
`session_endpoint_remote_request_multi_select.xml` under
`commcare-hq/corehq/apps/app_manager/tests/data/`.

Endpoints depend on durable released deployments, use the selected server, reject
flattened modules, preserve tenant authorization even when relevancy is bypassed,
and distinguish internal preview routes from shareable HQ links. Registry-search
smart links stay out of scope.

This is also the unit that must retire the two hardcoded US hosts named in
[HQ deployment safety](#hq-deployment-safety): a deep link that ignores the
selected server sends an India or EU deployment's users to the wrong cluster.

Binding facts:

- HQ's authoring fields are `ModuleBase.session_endpoint_id`,
  `ModuleBase.case_list_session_endpoint_id`, `FormBase.session_endpoint_id`,
  `FormBase.respect_relevancy` (default True), and
  `FormBase.function_datum_endpoints`. The whole feature is gated by
  `toggles::SESSION_ENDPOINTS` (frozen, domain-namespaced) — **a deployment
  prerequisite on the target domain**, carried in docs and the setup artifact,
  never a Nova authoring gate.
- Emission is one `<endpoint id>` per endpoint, one `<argument id>` per
  selection-requiring datum (multi-select arguments additionally carry
  `@instance-id` and `@instance-src="jr://instance/selected-entities"`), then a
  `<stack>` of `<push>` frames — **not** `<create>` — with a claim push per case-id
  argument (a `<datum>` plus
  `<command value="'claim_command.<endpoint_id>.<arg_id>'"/>`, skipped for
  inline-search modules), followed by the navigation frame built by the **same**
  `WorkflowHelper.get_frame_children` machinery as end-of-form navigation.
  `respect-relevancy="false"` is emitted only when False.
- `respect_relevancy` exists **only** on `FormBase`, and `EndpointsHelper` passes
  it only for form endpoints. A module-level toggle would emit into a local `.ccz`
  and then silently revert to true after HQ regeneration, so Nova must not offer
  the slot on modules.
- A case-list endpoint **excludes** the trailing selection datum
  (`should_add_last_selection_datum=False`): no `case_id` argument and no claim
  frame for it, so the link lands on the list rather than on a selected case.
- Runtime execution: arguments bind as XPath **variables**
  (`populateEndpointArgumentsToEvaluationContext` → `setVariable`), and
  missing/unexpected arguments throw `InvalidEndpointArgumentsException` with a
  user-visible "Invalid arguments supplied for link. Missing arguments: …". Stack
  ops replay one at a time, checking for a sync/claim screen after each and running
  `doPostAndSync` mid-sequence (claim failure → "Unable to claim case."), then
  `rebuildSessionFromFrame(respectRelevancy)` re-derives and replays the selection
  path — and with `respectRelevancy=false` it walks `getAllChoices()`, traversing
  menus and cases that display conditions would hide.
- `workflow.py::WorkflowQueryMeta.to_stack_datum` rewrites a query datum's URL
  from `/phone/search/` to `/phone/case_fixture/` to hydrate a single **known**
  case without running a live search — the mechanism any deep link landing on a
  specific case without a search screen depends on.
- The public web URL contract is
  `/a/<domain>/app/v1/<app_id>/<endpoint_id>/?arg=…` →
  `cloudcare/views.py::session_endpoint`, which gates on the toggle, resolves the
  latest build, and redirects into the Web Apps SPA.
- `jump` is a frame **step** that sets a redirect URL and terminates the push
  early — never a stack op.
- `cc-auto-advance-menu` self-selects a single **visible** choice (relevancy
  filters first), auto-advanced menus are omitted from the persistent menu and
  breadcrumb, and under `respect-relevancy="false"` reconstruction counts **all**
  choices — so deep-link advance behavior can diverge from the live view. These are
  documented sharp edges, not Nova bugs to fix.

**Observed:** an author copies a link that opens a specific case in a specific
form, and is told plainly when the target domain lacks the required toggle.

**Depends on:** units 13 and 16 — 13 rather than 12 because a shareable link must
resolve to a *released* build whose referenced tables and locations already exist
on the target; linking into an app whose lookup tables were never pushed produces
a dead claim frame at runtime rather than a build-time error.

### 18 — Multi-select, related cases, and profile extensions

**PRs:**
1. `Multi-select case lists and selected-case operation semantics`
2. `Related-case pulls in case search`
3. `Authored app-profile properties`

Three independent vocabularies that only share a dependency, so they ship as three
PRs rather than one with a contingency. Every HQ JSON and compiler projection
stays identical across all three.

Define selected-case runtime semantics before suite flags: ordinary primary-case
preloads and writes must either reject or lower through per-selected-case
operations. Add preview repeat materialization, integer limits 1–100,
empty-selection behavior, and cross-page/search/back persistence.

Binding facts:

The emitted datums and claim POST are asserted against
`suite/multi_select_case_list/basic_remote_request.xml` and
`session_endpoint_remote_request_multi_select.xml` under
`commcare-hq/corehq/apps/app_manager/tests/data/`.

- **Multi-select.** The short detail carries `multi_select` (Boolean) and
  `max_select_value` (Integer, default 100); emission swaps the datum class to
  `<instance-datum … max-select-value="N">`; selected ids materialize as a virtual
  instance (`jr://instance/selected-entities/…`, a `<results><value>` shape) that
  forms read as `instance('selected_cases')`; the client enforces the cap
  (`DEFAULT_MAX_SELECT_VAL = 100`,
  `MultiSelectEntityScreen.validateSelectionSize`); and claim is **one** POST
  carrying all ids, with 204 meaning already claimed.
- **Related-case pulls** emit as query `<data>` keys
  `x_commcare_include_all_related_cases` (`ref="'true'"`) and
  `x_commcare_custom_related_case_property`. Result-instance nodesets append
  `EXCLUDE_RELATED_CASES_FILTER = "[not(commcare_is_related_case=true())]"` so
  pulled relatives ride the instance without polluting the visible list.
- **App-profile custom properties** ride the app JSON untouched at import and emit
  as `<property key value force="true"/>`, but HQ merges them **only** when the
  domain has the `CUSTOM_PROPERTIES` toggle; Nova's own local `profile.ccpr` is
  ungated. The three verified keys and their Formplayer effects are
  `cc-sync-after-form` (sync after every submission), `cc-auto-advance-menu` (a
  single visible choice self-selects and the advanced menu drops out of the
  persistent menu and breadcrumb), and `cc-index-case-search-results`.
  `lib/commcare/compiler.ts::generateProfile` currently hardcodes its property
  list; this unit makes exactly those three `cc-*` keys authored. The
  emitter-owned properties — the app name, the `cc-content-version` blueprint
  stamp every export carries, `cc-app-version`, and the logo — stay reserved and
  unauthorable, because an author who overwrites the version stamp breaks the
  upgrade path silently.
- **Several `CaseSearch` fields are removed upstream and must never be modeled or
  reproduced:** `search_label`, `additional_relevant`, `dynamic_search`, and
  `search_filter`.

**Observed:** a worker selects several cases at once and runs one form over all of
them.

**Depends on:** unit 13 — the profile PR needs a live push path to confirm that
the `CUSTOM_PROPERTIES` toggle is present on the target before offering authored
properties that HQ would otherwise merge away silently.

---

## Dependency order

Each unit's prerequisites, matching its "Depends on" line above:

| Unit | Needs |
| --- | --- |
| 1 conditions/operations authoring | — |
| 2 Project data workspace | — |
| 3 SA, MCP, docs | 1, 2 |
| 4 tile wire | — |
| 5 tile query/preview/authoring | 4 |
| 6 media capture | — |
| 7 attachment emission and link UX | 6, 12 |
| 8 user types and personas | — |
| 9 organization and locations store | 8 |
| 10 usercase, owner sets, wire | 9 |
| 11 automations | 8, 9 |
| 12 deployment core and artifact | 8, 9, 11 |
| 13 push and provisioning drivers | 12 |
| 14 App setup UI, SA, MCP, docs | 8, 9, 10, 11, 12, 13 |
| 15 form links and sections | — |
| 16 nested menus and linked-form reuse | 15 |
| 17 session endpoints and deep links | 13, 16 |
| 18 multi-select, related cases, profile | 13 |

Six units have no outstanding prerequisites and can start in any order: 1, 2, 4,
6, 8, and 15. They are also the six independent entry points — every other unit
descends from one of them.

Two chains dominate the critical path. The deployment chain
(8 → 9 → 11 → 12 → 13) gates units 7, 14, 17, and 18, so anything needing a real
HQ target waits on it. The navigation chain (15 → 16 → 17) is independent until
17, which needs both.

Units 3, 5, 7, 14, 17, and 18 are leaves — nothing waits on them, so each can land
whenever its own prerequisites are met. Unit 10 sits off the deployment chain's
critical path: only the App setup UI waits on it, so it can follow unit 9 at any
point without holding up unit 12.

---

## Keeping this file honest

This document changes in the same PR as the behavior it describes. Three rules:

- **Present tense only.** Describe what the system does. If a sentence needs a
  date, a PR number, a revision, or a branch name to make sense, it belongs in the
  commit message.
- **Move a unit, don't annotate it.** When a unit ships, its contract moves into
  [What is built](#what-is-built) rewritten as current behavior, and its entry in
  [What remains](#what-remains) disappears. No "shipped" markers, no status column,
  no changelog entry.
- **Anchor every platform claim.** A CommCare constraint carries its
  `file::function` when it is load-bearing. A claim with no anchor is a claim
  nobody can re-verify when upstream moves.
