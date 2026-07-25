# Complex app plan

Nova's plan for building complex CommCare apps: lookup tables, display
conditions, case operations, case tiles, media capture, users and locations,
automations, and HQ deployment.

This is the only planning document for that program. It describes the system as
it is today and indexes the work that remains. Its primary sources are the two
research memos in `docs/research/` — `advanced-case-actions.md` and
`commcare-locations.md` — which stay as evidence; where a memo and this document
disagree, this document wins. It carries no history: what shipped, when, in which
PR, and against which revision lives in git. When behavior changes, this file
changes with it in the same PR.

Every CommCare citation uses stable names (`file::function`), never line numbers
— upstream lines rot silently.

---

## How to use this plan

The program spans three kinds of file, and each answers exactly one question:

| File | Answers |
| --- | --- |
| this one | what Nova builds today, and which unit owns what remains |
| [`complex-app/00-contracts.md`](complex-app/00-contracts.md) | the delivery, product, architecture, and UX rules that bind every unit |
| `complex-app/NN-*.md` | one remaining unit: its contract, its binding CommCare facts, what a user observes |

Three rules govern reading them, in order:

- **Open the unit's file before you touch the unit.** The entries under
  [What remains](#what-remains) route you to a file; they do not brief you on it.
  Each one deliberately omits every binding fact, wire contract, and design fence
  the unit rests on — so planning, estimating, implementing, or answering a
  question from an index entry alone produces a confident wrong answer. The
  omitted facts are exactly the ones that decide the shape of the work.
- **Read the contracts file alongside it.** The rules there are stated once and
  never repeated in a unit file. A unit implemented without them will pass its own
  acceptance and still violate the program — a version floor, a draft state, a
  silently adopted remote resource, or a workspace masquerading as app content.
- **Re-verify every CommCare claim in source before you rely on it.** The facts
  recorded here were verified against the Dimagi checkouts at the time they were
  written; upstream moves. Each carries its `file::function` so it can be
  re-verified — never restate one from memory, and never soften one you could not
  re-find.

For shipped behavior, [What is built](#what-is-built) states what exists and why
it takes the shape it does; the code and the nearest subtree `CLAUDE.md` remain
authoritative for how.

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
The authoring surfaces say so in as many words rather than letting an author read
a condition as a permission.

Each carrier is authored on its own URL — `/{moduleUuid}/condition` and
`/{formUuid}/condition` — whose centre-canvas screen leads with where the
condition takes effect and then hosts the shared `PredicateWorkbench`. The module
and form settings panels own the setting itself: a plain-language summary plus
Add / Edit / Clear, through the shared `ConditionSlotSetting`. Adding is one
gesture that commits a valid seed and opens the editor on it, so an author never
lands on an empty screen.

The evaluation locus above is a product requirement, not just a validator rule,
because it decides what the editor may offer. `CaseDataScope` therefore has three
values: `per-case` (case rows and their relatives), `selected-case` (one chosen
case's own properties — relationship walks, relationship counts, and presence
tests are withheld with the scope's own explanation), and `global` (no case at
all). A module condition and a forms-first form condition are `global`; a
case-first form condition is `selected-case`. `PredicateEditProvider` composes
the matching admission oracle in front of any caller oracle, so no surface can
silently offer a read the commit gate would reject.

A second, independent axis governs **Never match**. `DISPLAY_CONDITION_ALWAYS_FALSE`
refuses a navigation condition nobody could satisfy, so the editor withholds
`match-none` there — but the same shape is legitimate authored data in the
Search-action carrier, which shares the `global` scope. `allowsNeverMatch`
therefore stands apart from `CaseDataScope`, defaults to allowed, and governs
exactly one kind; reading it off the scope would have made an existing document
uneditable. A saved `match-none` always renders and re-emits: the flag governs
the add and replace menus, never round-tripping.

Every *single* choice these editors offer is admissible, but "can never match" is
a property of the whole tree — an author can still compose one deliberately by
excluding an always-true rule. The condition canvas therefore commits through the
inline gate flavor and shows a refusal beside the rule, rather than a toast over
a silently reverted edit.

Preview from a condition URL runs the surface the condition governs — the home
screen for a module (entering the module would route straight past the screen the
condition decides), the form itself for a form — and leaves the URL alone, so
exiting Preview returns to the condition being edited.

Removing a condition is an explicit `null` on the `updateModule` / `updateForm`
patch (`lib/doc/displayConditionMutations.ts`), never an omitted key. The
reducers delete on either spelling, so the distinction bites only where a
mutation object is itself the durable event — the SSE frame and the persisted
jsonb are both `JSON.stringify`, which drops an `undefined`-valued key and turns
a clear into "no change". The builder persists a document diff instead, and
`diffDocsToMutations` reaches the same `null` independently; the planners keep
the mutation correct on its own so a durable emitter inherits the right spelling
rather than rediscovering it.

`content/docs/display-conditions.mdx` is the user-facing guide.

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

### User properties, user types, and preview personas

Three flat blueprint collections answer three separate questions, and the
distinction is load-bearing everywhere downstream (`lib/domain/users.ts`):

- a **user property** is a slot workers carry data in — the app's half of
  CommCare's per-domain custom user-data schema;
- a **user type** is a reusable role template that fills those slots with
  default values;
- a **persona** is a named design/test actor with stable identity that
  *references* a user type and may override individual values. It is who Preview
  runs as.

A **deployed worker** — a real identity on a target HQ domain, with credentials
and its own lifecycle — is deliberately absent. It is owned by a deployment,
created *from* a type or persona, and is not a blueprint identity.

The wire facts the shape rests on:

- HQ stores one `CustomDataFieldsDefinition` per `(domain, field_type)`
  (`custom_data_fields/models.py::CustomDataFieldsDefinition`); mobile and web
  users share `field_type='UserFields'`
  (`users/views/mobile/custom_data_fields.py::UserFieldsView`) and split only by
  per-field `required_for`. So one app's catalog compiles to that one
  definition.
- Slug legality is enforced at construction so a push can never fail on identity
  grounds: the Django slug charset
  (`custom_data_fields/edit_model.py::XmlSlugField` lists `validate_slug`), at
  least one non-digit (its `RegexValidator(r'\D', '')`), `SYSTEM_FIELDS` and the
  `commcare` / `xml` prefixes (`models.py::validate_reserved_words`), the
  case-reserved words and case-insensitive uniqueness
  (`edit_model.py::CustomDataFieldsForm.verify_no_reserved_words` /
  `::verify_no_duplicates`), and the 127-character column. `RESERVED_CASE_PROPERTIES`
  is HQ's `case-reserved-words.json` plus `name` and `owner_id`, both already
  system fields, so one list covers every clause. Nova compares it lowercased
  and is therefore marginally stricter than HQ on mixed case (`Name` is refused
  here, accepted there) — stricter never costs a push.
- The restore's `<Registration><user_data>` block injects framework keys **after**
  authored data, so they win collisions
  (`users/models.py::CouchUser.get_user_session_data`): `commcare_project`,
  `commcare_first_name`/`_last_name`/`_phone_number`, `commcare_user_type`,
  `commcare_location_id`/`_ids`/`commcare_primary_case_sharing_id`, plus
  `user_type='demo'` for practice users. `commcare_profile` reaches the same
  block by a different route — `users/user_data.py::UserData._provided_by_system`
  always includes the slot, so it rides in through `to_dict` rather than being
  injected after it. That combined set **is** `BUILT_IN_USER_PROPERTIES` and the
  reserved-name list — there is no second source, and
  `lib/domain/__tests__/users.test.ts` asserts the relationship rather than
  restating it.
- **`user_type` is the one key the restore does not decide.** HQ sends it only
  for a practice user, but the CLIENT seeds it: every
  `commcare-core .../User.java` constructor calls `setUserType(STANDARD)` — a
  plain `properties.put` — and `UserXmlParser::parse` builds the `User` before
  applying any `<data key>`. Both runtimes use that parser
  (`CommCareTransactionParserFactory::initUserParser`; Android subclasses it).
  So an ordinary worker's device holds `user_type = "standard"` and a practice
  user's restore overwrites it with `"demo"`; the key is never absent, which is
  why Preview supplies `"standard"` rather than leaving it out.
- Only three keys are read by the runtime framework: `user_type` (demo
  detection — `commcare-core .../User.java::getUserType`) and `commcare_project`
  + `commcare_location_ids`, read together by
  `formplayer .../UserUtils.java::getUserLocationsByDomain` to drive the local
  case purge in `RestoreFactory`. Everything else in `session/user/data` is
  inert.
- The client's registration parser writes every `<data key>` into
  `User.properties` verbatim — no key restrictions, last-wins on duplicates
  (`commcare-core .../UserXmlParser.java::parse`) — and merges into a retrieved
  user without clearing, so a key deleted on HQ lingers until a full resync.
  Nova documents that staleness rather than simulating it.
- `CustomDataFieldsProfile` sits behind the paid `APP_USER_PROFILES` privilege
  and is deliberately not the provisioning model; a user type compiles to plain
  per-user `user_data` values.

Two of HQ's `Field` columns are deliberately excluded from constructible state.
`regex` / `regex_msg` sit behind the paid `REGEX_FIELD_VALIDATION` privilege —
`edit_model.py::CustomDataModelMixin.get_field` drops the pattern and keeps
`choices` without it — so an authored pattern would silently not validate on a
stock domain. `required_for` is the mobile/web split, and Nova provisions mobile
workers only: web users arrive through HQ's `InvitationResource`, which resolves
a role by name a user type cannot supply.

Whether a persona satisfies a `required` property is likewise not a document
finding. HQ enforces the flag only when the pushed field's `required_for` names
the user type being created
(`users/views/mobile/custom_data_fields.py::UserFieldsView.is_field_required` —
NOT `edit_model.py::CustomDataModelMixin.is_field_required`, a different
function that returns a bare `field.is_required`), so it is a question about
one deployment target, and gating on it would make marking an existing property
required impossible. The authoring surface says so inline instead.

### Preview identity

`lib/preview/engine/identity.ts` carries **two ids that are not
interchangeable**. `actorUserId` is the signed-in member and the only thing that
ever authorizes; `ownerId` is the CommCare worker the preview acts as — the
`owner_id` stamp on rows it writes and the value `session/context/userid`
resolves to. Previewing as a persona makes `ownerId` that persona's UUID while
the member still authorizes, so a case list filtered to the current user shows
that persona's caseload. Keying authorization on `ownerId` would let authored
blueprint content choose whose data a request reads;
`lib/preview/engine/__tests__/identity.test.ts` pins that the two cannot be
re-conflated, and `withProjectContext(projectId, actorUserId, ownerId)` carries
the split into the case store, where authorization fences read the member and
`owner_id` / `acting-user` read the worker.

The identity carries **two projections of one worker**, because the wire has
two. `session` is `instance('commcaresession')/session/…`, built by
`commcare-core .../SessionInstanceBuilder.java::addMetadata` +
`::addUserProperties`. `usercase` is the `commcare-user` case `#user/<prop>`
reads, built independently by `callcenter/sync_usercase.py::_get_user_case_fields`
— same authored data, different built-in keys (`first_name` there,
`commcare_first_name` in the session block).

**The three location keys diverge between the two projections**, and the
asymmetry is easy to state backwards: `get_user_session_data` writes all three
or none, so the session block omits them while nobody is assigned anywhere,
while `_get_user_case_fields` takes an explicit `else` branch to `''` for all
three, so the usercase always carries them. `commcare_profile` likewise appears
on both.

Preview values are otherwise honest. `commcare_project` is **absent** until a
deployment target supplies a domain, and `commcare_phone_number` is absent
because Nova has no HQ account to read it from. `commcare_user_type` is
`'commcare'` (`users/models.py::COMMCARE_USER` — not the same-named
`UserFieldsView.COMMCARE_USER`, which is `'commcare_user'`, nor
`change_feed/topics.py::COMMCARE_USER`, which is `'commcare-user'`),
`commcare_profile` is empty, and `user_type` is `"standard"`, because all three
are knowable rather than invented. A **declared** property with no value is
present-and-empty, matching `users/user_data.py::UserData.to_dict`'s
`{field: '' for field in self._schema_fields}` seed, while an undeclared key is
genuinely absent — the split a `= ''` comparison depends on.

Deleting a persona never deletes case data: rows it owns keep naming it, and the
confirmation states how many rows that is rather than offering to reassign or
remove them. **This is Nova's own rule, not HQ parity** — HQ has two different
answers and neither is a template for it. Deactivating a worker, or removing
them from the domain, closes their usercase and leaves their cases alone
(`sync_usercase.py::_get_sync_usercase_helper` computes
`close = to_be_deleted or not is_active_in_domain or domain not in domains`).
DELETING one is destructive: `users/models.py::CommCareUser.retire` →
`::delete_user_data` soft-deletes every case the worker owns via
`tag_cases_as_deleted_and_remove_indices` and strips their indices. A persona is
a design and test actor rather than a person who left an organization, and the
cases it created are the author's own test data, so silently soft-deleting them
would be a destructive surprise. Preserving them is the deliberate choice.

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
- Preview runs as the signed-in member or as a named persona, and the two modes
  never blend: the running app always states which identity it is showing.

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
authoring media (menu icons, field images); a worker's own captures are the
attachment questions below and never enter this library.

### Attachment questions

Five capture kinds — image, audio, video, signature, and file — carry a label,
hint, `required`, and `relevant` and nothing else. `captureFieldKinds`
(`lib/domain/fields`) is the single home for which kinds are captures; the
reference-slot applicability groups, the case-property rejection, and the wire
emitter all read it. Each emits `<upload ref mediatype>` over a `<bind
type="binary">` and nothing else — no suite entry, no app-level declaration
(fixture: `form_preparation_v2/attachment.xml`).

**The `mediatype` is a closed four-literal enum with no fallback, and the
emitter makes an unmatched value unrepresentable rather than checking for one.**
`XFormParser::parseUpload` matches with literal `String.equals` against
`image/*`, `audio/*`, `video/*`, and `application/*,text/*` (comma, no space).
Anything else leaves the control at `CONTROL_UPLOAD`, `entries.js::getEntry`
falls through to `UnsupportedEntry`, and that constructor **sets the answer** to
the literal string `Not Supported by Web Entry`, which then submits. The failure
mode is silent bad data, so `UPLOAD_MEDIATYPE_BY_CAPTURE_KIND`
(`lib/commcare/xform/captureUpload.ts`) is a total table over the capture kinds
into a four-member literal type, and a new kind fails `tsc` until it names one.

Signature is its own Nova kind emitted as `image/*` plus
`appearance="signature"` — the wire collapses it onto the image control and
`entries.js::getEntry` splits it back apart on that appearance, but every
worker-visible property differs. `appearance="face"` stays out: Vellum authors it
and it is inert on both runtimes Nova targets. `jr:imageDimensionScaledMax` stays
out for the same reason — `UploadQuestionExtensionParser` is registered only by
`commcare-android`, so Web Apps does no downscaling and uploads the picked bytes.

File attachments are a first-class Web Apps kind (`entries.js::DocumentEntry`,
accept list `.pdf,.xlsx,.docx,.html,.txt,.rtf,.msg`) with full receiver support,
and they carry one asymmetry stated where the author picks the kind:
`CONTROL_DOCUMENT_UPLOAD` appears nowhere in `commcare-android`, so
`WidgetFactory::createWidgetFromPrompt` falls to `StringWidget` and a worker
there types free text into a `binary` node.

The declared target CommCare version (`hqShells.ts::applicationShell`'s
`build_spec.version`) is the **maximum** of every floor Nova's vocabulary
implies: 2.54 for menu-level instance declarations, 2.57 for file attachments
(`feature_support.py::support_document_upload`). That 2.57 gate is
authoring-palette-only — its one consumer repo-wide is
`views/formdesigner.py::_get_vellum_features` — so an emitted form renders
regardless; declaring the true floor is about not claiming a compatibility HQ
itself does not. It is declarative on the upload path either way, because
`models/applications.py::import_app` deletes `build_spec` and
`ApplicationBase.wrap` substitutes the target domain's default.

`FORM_TOO_MANY_ATTACHMENTS` rejects a form whose **non-repeating** capture
questions exceed `MAX_FORM_ATTACHMENTS` (50). Formplayer counts at submit time
over the session media directory (`FormSubmissionHelper::getMultiPartFormBody`,
before any per-file logic) and the whole submission aborts, with no worker-facing
way to shed a file — so a form past the cap is a dead end once fully answered.
The walk stops at a repeat deliberately: a capture there produces one attachment
per iteration and the worker chooses the count, so no authoring-time number
bounds it, and counting the template once would imply a guarantee the check
cannot make.

**Every author- and worker-facing string says "attach", never "take" or
"record".** Web Apps has no camera, microphone, or recorder anywhere in
cloudcare — `entry_file.html` binds only `accept` on its file input, and
`getUserMedia` / `MediaRecorder` / `capture=` occur nowhere in it. Every kind but
signature is the OS file picker. CommCare Android is the contrast, and that
contrast is a docs fact rather than a Nova behavior.

`lib/commcare/validator/rules/form.ts::mediaCaseProperty` keeps rejecting a
capture kind carrying `case_property_on`, and `formActions.ts` skips capture
kinds when building the case-update map. Writing a capture onto the case is
inseparable from emitting its URL column, so the two ship together (unit 6).

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

Sixteen units, one file each. **Every entry below is a pointer, not a summary of
record** — the contract, the binding CommCare facts, the wire shapes, and the
observed outcome live only in the linked file, and each entry names what it is
withholding so you can tell when you need it. Read that file, and
[`00-contracts.md`](complex-app/00-contracts.md), before you plan or implement.

### 1 — Case-operation authoring

[`complex-app/01-conditions-and-operations-authoring.md`](complex-app/01-conditions-and-operations-authoring.md)
· depends on nothing · blocks unit 3

The builder authoring surface for the case-operation vocabulary that already
validates, emits, and previews. **The file holds** the 20-operation stress case
and its interaction model, the planner refusals the reorder UI must surface
before the gesture, and which vocabulary unit 1 deliberately excludes.

### 2 — Project data tables workspace

[`complex-app/02-project-data-workspace.md`](complex-app/02-project-data-workspace.md)
· depends on nothing · blocks unit 3

The Project data workspace — schema and row grid, atomic CSV import, revisions,
conflict handling, permissions — plus the select options-source editor and the
confirmation UX that lets lookup schema governance leave package-private scope.
**The file holds** the asymmetric source-mode switch, the one semantic that
silently ships an inert feature when missed.

### 3 — SA, MCP, and docs for conditions, operations, and lookups

[`complex-app/03-sa-mcp-and-docs-for-conditions-operations-lookups.md`](complex-app/03-sa-mcp-and-docs-for-conditions-operations-lookups.md)
· depends on units 1 and 2 · blocks nothing

Expose the shipped conditions, operations, and lookup vocabulary through both the
camelCase chat tools and the snake_case MCP projection, with public docs and one
integrated end-to-end flow. **The file holds** the two pieces of engineering under
that packaging: the SA identity bridge and the null-clears contract.

### 4 — Case tiles

[`complex-app/04-case-tiles.md`](complex-app/04-case-tiles.md)
· depends on nothing · blocks nothing

Tile layout authoring, preview, and wire in one PR; grouped tiles in a second.
**The file holds** the `<style>`/`<grid>` field contract, the `header-rows`
attribute and the fixture that misspells it, why grouping must happen at the data
layer rather than after a page is fetched, where the 12-column cap actually comes
from, and why Nova emits only HQ's `custom` tile vocabulary.

### 5 — Capture, storage, and submission lifecycle

[`complex-app/05-media-capture-in-forms.md`](complex-app/05-media-capture-in-forms.md)
· depends on nothing · blocks unit 6

Capture in the running preview: staged upload at pick time through the durable
landing a submission gives it. **The file holds** the server-generated naming
Nova must not reinvent, why "attachments on the form" is not "captures the worker
kept", the two upstream Formplayer defects to design around, and what a worker
can actually see after attaching.

### 6 — Attachment target-aware emission and link UX

[`complex-app/06-attachment-emission-and-link-ux.md`](complex-app/06-attachment-emission-and-link-ux.md)
· depends on units 5 and 11 · blocks nothing

Save-to-case attachment shapes, target-aware URL-column emission, explicit link
presentation, and the opt-in legacy attachment mode. **The file holds** the exact
bytes endpoint and the HTML viewer route that must never be linked instead, the
calculate that builds the URL, and why Web Apps never displays a case attachment
in-app.

### 8 — Organization model and locations store

[`complex-app/08-organization-model-and-locations-store.md`](complex-app/08-organization-model-and-locations-store.md)
· depends on nothing · blocks units 9, 10, 11, 13

The app-wide custom-field catalog, stable level and site codes, app-scoped
location rows, archive and reassignment rules, and role-aware owner validation.
**The file holds** the two independent flag axes that are classically conflated,
the owner-set assembly with its two easily-dropped filters, and what actually
happens to cases when a location loses its last worker.

### 9 — Usercase, owner sets, restore scope, and wire

[`complex-app/09-usercase-owner-sets-and-wire.md`](complex-app/09-usercase-owner-sets-and-wire.md)
· depends on unit 8 · blocks unit 13

Usercase materialization, owner-set derivation, tenant-complete restore closure,
and the flat location fixture. **The file holds** the three-rule liveness fixpoint
the preview must reproduce rather than approximate, the flat fixture's byte
contract, and the instance-declaration precondition that silently voids the whole
fixture when missed.

### 10 — Representable automations and setup guidance

[`complex-app/10-automations-and-setup-guidance.md`](complex-app/10-automations-and-setup-guidance.md)
· depends on unit 8 · blocks units 11 and 13

Automation schemas limited to what HQ can represent, plus regenerated setup
guidance. **The file holds** the closed criteria, action, recipient, and content
vocabularies, the real cadence and cap (and the widely cited figure that is
wrong), the total absence of a REST surface, and which criteria are constructible
versus setup-artifact-only.

### 11 — Deployment core and artifact

[`complex-app/11-deployment-core-and-artifact.md`](complex-app/11-deployment-core-and-artifact.md)
· depends on units 8 and 10 · blocks units 6, 12, 13

Durable deployment and resource-mapping records, preflight, ownership and
adoption, independently retryable phases, and the target-aware setup artifact.
**The file holds** the state machine enumerated end to end, including which state
a required-phase failure lands in and what it withholds.

### 12 — Push and provisioning drivers

[`complex-app/12-push-and-provisioning-drivers.md`](complex-app/12-push-and-provisioning-drivers.md)
· depends on unit 11 · blocks units 13, 16, 17

Referenced-table push, location push, and explicit worker provisioning against
unit 11's ownership mappings. **The file holds** the fixapi workbook's actual
format, why a tag rename cannot be an in-place PUT, the v0.6 location API's
semantics and caps, the user resource's create-only identity, and which part of
the org model is not pushable at all.

### 13 — App setup UI, SA, MCP, and docs

[`complex-app/13-app-setup-ui-sa-mcp-and-docs.md`](complex-app/13-app-setup-ui-sa-mcp-and-docs.md)
· depends on units 8, 9, 10, 11, 12 · blocks nothing

The App setup workspace's three remaining sections — Organization, Automations,
and Deployment — plus the SA and MCP surfaces and public docs for units 8 through
12. **The file is deliberately short**: its substance is the prerequisite units'
files and the baseline UI review in the contracts.

### 14 — Exclusive form links and sections

[`complex-app/14-form-links-and-sections.md`](complex-app/14-form-links-and-sections.md)
· depends on nothing · blocks unit 15

An exhaustive-`else` link projection with durable link identity in one release,
then form sections with fractional order. **The file holds** the six end-of-form
workflow mappings and their traps, the closed stack vocabulary, the negative sweep
proving sections have no wire notion, the no-expression-slots design fence, and
the verified mechanics that make sections beat multi-form chains.

### 15 — Nested menus and linked-form reuse

[`complex-app/15-nested-menus-and-linked-form-reuse.md`](complex-app/15-nested-menus-and-linked-form-reuse.md)
· depends on unit 14 · blocks unit 16

One-tier menu nesting and native linked-form reuse. **The file holds** what
`root_module_id` and `put_in_root` each emit, and why shadow modules are
wire-level duplication rather than reference — which is what lets Nova emit the
shape with no shadow authoring object and no domain toggle.

### 16 — Session endpoints and deep links

[`complex-app/16-session-endpoints-and-deep-links.md`](complex-app/16-session-endpoints-and-deep-links.md)
· depends on units 12 and 15 · blocks nothing

Session endpoints and shareable deep links resolved against the selected HQ
server. **The file holds** the emission shape and why it pushes rather than
creates, why `respect_relevancy` exists only on forms, what a case-list endpoint
excludes, the runtime replay sequence, and the documented divergences that are
sharp edges rather than Nova bugs.

### 17 — Multi-select, related cases, and profile extensions

[`complex-app/17-multi-select-related-cases-and-profile.md`](complex-app/17-multi-select-related-cases-and-profile.md)
· depends on unit 12 · blocks nothing

Three independent vocabularies that ship as three PRs because they share only a
dependency. **The file holds** the multi-select datum and its virtual instance,
the related-case query keys and exclusion filter, the three authorable `cc-*`
profile keys against the reserved emitter-owned ones, and the removed `CaseSearch`
fields that must never be modeled.

---

## Dependency order

Each unit's prerequisites, matching the "Depends on" line in its file:

| Unit | Needs |
| --- | --- |
| [1 case-operation authoring](complex-app/01-conditions-and-operations-authoring.md) | — |
| [2 Project data workspace](complex-app/02-project-data-workspace.md) | — |
| [3 SA, MCP, docs](complex-app/03-sa-mcp-and-docs-for-conditions-operations-lookups.md) | 1, 2 |
| [4 case tiles](complex-app/04-case-tiles.md) | — |
| [5 media capture in forms](complex-app/05-media-capture-in-forms.md) | — |
| [6 save-to-case and attachment link UX](complex-app/06-attachment-emission-and-link-ux.md) | 5, 11 |
| [8 organization and locations store](complex-app/08-organization-model-and-locations-store.md) | — |
| [9 usercase, owner sets, wire](complex-app/09-usercase-owner-sets-and-wire.md) | 8 |
| [10 automations](complex-app/10-automations-and-setup-guidance.md) | 8 |
| [11 deployment core and artifact](complex-app/11-deployment-core-and-artifact.md) | 8, 10 |
| [12 push and provisioning drivers](complex-app/12-push-and-provisioning-drivers.md) | 11 |
| [13 App setup UI, SA, MCP, docs](complex-app/13-app-setup-ui-sa-mcp-and-docs.md) | 8, 9, 10, 11, 12 |
| [14 form links and sections](complex-app/14-form-links-and-sections.md) | — |
| [15 nested menus and linked-form reuse](complex-app/15-nested-menus-and-linked-form-reuse.md) | 14 |
| [16 session endpoints and deep links](complex-app/16-session-endpoints-and-deep-links.md) | 12, 15 |
| [17 multi-select, related cases, profile](complex-app/17-multi-select-related-cases-and-profile.md) | 12 |

Six units have no outstanding prerequisites and can start in any order: 1, 2, 4,
5, 8, and 14. They are the independent entry points — every other unit descends
from one of them.

The deployment chain (8 → 10 → 11 → 12) is the critical path: it gates units 6,
13, and 16, so anything needing a real HQ target waits on it. The navigation
chain (14 → 15) runs independently until unit 16, which needs both.

Units 3, 4, 6, 13, 16, and 17 are leaves — nothing waits on them, so each can land
whenever its own prerequisites are met. Case tiles (unit 4) are both an entry
point and a leaf: nothing blocks them and nothing waits on them, which makes them
the natural filler whenever the deployment chain is blocked on something external.
Unit 9 sits off the critical path too — only the App setup UI waits on it, so it
can follow unit 8 without holding up unit 11.

---

## Keeping these files honest

These files change in the same PR as the behavior they describe. Five rules:

- **Present tense only.** Describe what the system does. If a sentence needs a
  date, a PR number, a revision, or a branch name to make sense, it belongs in the
  commit message.
- **Move a unit, don't annotate it.** When a unit ships, its contract moves into
  [What is built](#what-is-built) rewritten as current behavior, and its unit
  file, its entry under [What remains](#what-remains), and its dependency row all
  disappear together. No "shipped" markers, no status column, no changelog entry.
- **One home per fact.** A binding CommCare fact lives in exactly one place: this
  file once it is shipped behavior, or one unit file while it is not. The index
  entries and the dependency table restate nothing — a fact duplicated into the
  index is a fact that will silently rot there.
- **Anchor every platform claim.** A CommCare constraint carries its
  `file::function` when it is load-bearing. A claim with no anchor is a claim
  nobody can re-verify when upstream moves.
- **A new unit is a new file.** Adding one means a file under `complex-app/`, an
  entry under [What remains](#what-remains), and a dependency row — never a
  section grafted into this file.
