# Project data and app settings

Implementation starts at Nova `9a6dc789dd9f`. Source paths below use CommCare HQ `d6c6e16d8ae1`, Core
`8e9ba8d908e9`, Android `7a5584475580`, Formplayer `24383ac71bfb`, Connect `046c7fd78081`, and HQ’s Vellum
`01215f251c57`. HQ paths starting in an app are relative to `corehq/apps/`. The admissions below apply equally
at app birth, refresh, and bringing in a later HQ edit.

## 1. Project data

The 13 entries owned by `project-data-at-hq-size` cover media size, dotted, colliding and Unicode names, the tag
`types`, field properties and multiple values, row attributes, row owners, indexing, missing elements, table
size and the two choice consumers in Questions and Search. Three circumstances cover the number and shape of
places and the cardinality of an owner rule. The separate app-body parsing bound remains.

### 1A. Table definitions, cell values and expressions

Extend Project lookup storage in `lib/lookup`. A column has stable property identities, their wire names and an
index setting. A table has stable row-attribute identities and global or assigned-row distribution. Each row has
attribute values, an ordered list of occurrences per rich column, and typed assignments to workers, groups or
places. Each occurrence holds its exact text plus a map from property UUID to exact text. An absent declared
field in HQ contributes one empty occurrence, an explicitly empty list contributes zero occurrences, and an
empty string contributes one empty occurrence. A missing required row attribute is a source data error. This
follows `fixtures/fixturegenerators.py::ItemListsProvider.to_xml`. It also covers tables with only row
attributes. Keep existing typed scalar columns for Nova authoring. Read HQ columns as text even on refresh and
transfer of management. Preserve `007`, `1.50`, leading spaces, repeated values, empty strings and order. Never
infer dates or numbers.

Use `lib/lookup/managed.ts`, its table lock and separate definition and rows revisions. Reserve UUIDv7
identities for attributes and field properties exactly as for columns. Extend definition snapshots, Project
realtime notices, protected design/app edges, delete/refresh checks, and Project data tools. A schema or owner
edit that affects an existing reader takes its reviewed Project/table revision and complete set of dependent
apps. Offer scalar and repeated cell editing, property and assignment pickers, and revision-bound paginated
inspection. CSV replacement remains lossless only for scalar tables. Offer the rich table editor and typed
workbook/row import for the others. Give tools bounded pages with the same structured values.

Extend choice label/value/sort and lookup expression projections with a row attribute, a field occurrence and an
occurrence filtered by a property/value. Bind table, column, attribute and property by identity. In
`lib/commcare/lookup` and `lib/commcare/xpath` lower to the table’s real fixture and local instance alias. Honor
XPath nodeset ordering and first-node string conversion wherever the consumer requires a scalar. Share
resolution with Search and question choices and with the case-store compiler on admitted SQL slots. Gate a
malformed or ambiguous selector at its actual slot. Changes to assignments or repeated values must invalidate a
worker’s cached choices. Include missing-vs-empty, identical text with different properties and two rows with
different attributes in editor/reader, SQL, both worker engines and saved-answer tests.

Keep three name judgements separate. HQ’s table editor checks XML names and rejects lowercase `xml` at the start
(`fixtures/utils.py::is_identifier_invalid`). Core’s `org/javarosa/xpath/parser/Lexer.java::matchNCName`
consumes UTF-16 units, accepting uppercase/lowercase letters and underscore initially, and decimal digits, dot
and hyphen thereafter. Generate the admitted ranges from the pinned runtime predicates and test each range edge
in the Android and JVM readers. A stored XML name need only satisfy the wire consumer that uses it. The Lezer
name token, printer and identity resolver share the tested readable subset with group 7’s case-write names.
Retain refusal for a tag whose fixture source is routed to the case or ledger database. For collisions with
runtime **instance IDs**, allocate an available form-local alias by source before printing declarations or any
expression. Vellum does so in `src/form.js::addInstanceIfNotExists`. Reserve every real and generated instance,
handle two colliding aliases, and resolve the incoming alias by its declared source.

A period is legal in the table. Test the emitted spelling *in its consuming slot*. In HQ’s
`app_manager/xpath.py::dot_interpolate`, the exact pinned function changed `n.m` to `nCASEm` with replacement
`CASE`, and preserved `n.1`, `1.m` and quoted `'n.m'`. Admit paths that survive print/build/parse at that slot,
and report the specific unprintable reference where HQ interpolates it. Never rewrite the tag or field across
the Project to repair one use.

### 1B. What an HQ key can read

Discover referenced tables by tag and stable remote ID. Read the ordered rows of just that table with
`fixtures/resources/v0_1.py::FixtureResource.obj_get_list`. For a definition with row attributes or rich cells,
fetch each selected row through the **detail** of `LookupTableItemResource`. Join on requested row ID and table
ID, verify fields, sort key and exact ordered row set, then check definition and ordered content again before
accepting. The detail exposes `item_attributes` and field occurrences. Its *list* reads the whole project space
and provides no table filter. Do not collect unrelated rows. Retain fixed origins, authorization, pagination,
duplicate/missing row checks, cancellation and bounded retries in `lib/commcare/hq`. A moving read restarts or
asks for another review. It never yields a partial table.

The table/row APIs omit index flags and owner lists. Store **source-managed, unobserved** separately from
observed false, empty or an authored setting. In the source space a reviewed reference reads its own fixture and
a publish writes no table. Project data can take a selected-table workbook downloaded by a person through HQ’s
Lookup Tables page. `fixtures/download.py::_prepare_fixture` writes indexed fields and per-row user, group and
location columns. Read only the selected definition and row sheets. Join row UIDs to the live ordered inventory
under the selected server/domain/table and compare the values the workbook can preserve. Reject extra, missing,
duplicate or stale UIDs, mismatched definitions, ambiguous principals and untrusted workbook formulas. Preserve
the independent exact API cell values. Mark supplemental facts with their source and time. A workbook supplied
by an editor attests the missing facts as of the export. Later owner-only or index-only changes can leave the
entire API digest unchanged. Require renewed evidence for materializing a new destination or transferring
management. The app can come in without the file.

A table retained as a source reference has its definition, source-scoped ID, latest revision/digest and the
completeness of its facts. Page available rows from an authorized, revision-bound snapshot. When the row
assignment needed to determine a worker’s choices is unknown, Preview offers the worker-specific fixture from an
authorized restore or asks for the assignment workbook. Until then the dependent worker action explicitly
reports unavailable data. A Project data editor may inspect the authorized source inventory. It must never
become a device fixture for every worker. A refreshed restore identifies its source table, target and worker and
grants no access to other personas. A source reference with no readable row snapshot similarly offers refresh
and an explicit unavailable state. Expired credentials keep the last verified snapshot labeled as such and stop
any publish that requires freshness.

Use distinct projections for a worker’s **assigned lookup rows** and **case-sharing groups**.
`fixtures/models.py::LookupTableRowManager.iter_by_user` grants a row through the worker ID, any HQ group
membership, or a location on the primary location’s path. The latter includes ancestors. Union and deduplicate
matching *rows*, then apply HQ’s row order. Additional assigned locations and the case-sharing flag alone do not
grant lookup rows. Keep target principals typed and scoped by server/domain, with explicit per-target bindings
to Nova persona, group or place identities. Resolve assignments in authorized server reads before the worker
payload is built. A public or offline archive can embed global fixtures. An assigned-row table in an installable
archive declares the runtime fixture and requires the named space’s authenticated restore. A portable HQ app
package can carry protected table data only for an authorized editor exporting Project data, with the owner
mappings needed at installation. No general archive or another worker’s Preview receives private rows.

### 1C. Data size, wire carriers and deployment

Remove the 5,000-row, 250-column, 64 KiB cell, 256 KiB row and 8 MiB table limits as **total imported-data**
limits. Keep the existing 8 MiB CSV request and ordinary interactive write limits. Replace one-shot per-table
JSONB snapshots with ordered row/occurrence pages, bigint totals and streaming digests. Stage ordered chunks of
large content under a Project-scoped generation and expose exactly one completed generation by atomically
changing its table pointer. Keep large content outside a single JSONB field or route body. Extend
`lib/lookup/fixtureSnapshot.ts`, `lib/commcare/lookup/{fixtures,textWorkbook,workbook}.ts`,
`lib/export/localArchive.ts` and the readers, including the caller in Preview that currently needs a whole
table. Build a complete per-worker snapshot in a paged local store before running a form, or stop that entry if
the device lacks capacity. Never run expressions over the first page. Stream service-side archive members so
10,000 rows, 100,000 cells and 16 MiB become regression boundaries for the old in-memory implementation.
Preserve per-response and per-process budgets in `lib/commcare/hq/bounds.ts`. Use bounded concurrency,
incremental row hashing, byte-bounded buffers, backpressure, cancellation and cleaned-up scratch files. For a
source too large for one interactive read, admit its confirmed live reference first. An editor can then request
a persistent Project data refresh with ordered restart checkpoints, an unpublished staged generation and
terminal counts/digest. Revalidate the source before promoting that generation. This leaves Step 6’s two-request
app reading read-only and never retains an unaccepted app review. A body, device, storage or deadline failure
names the failed operation. It cannot turn a missing page into a completed snapshot.

Plan the **carrier per table and destination** before writes.

| Preconditions | Delivery and verification |
|---|---|
| Complete global or assigned table representable in HQ’s workbook | Build text-only sheets in HQ’s header conventions for properties, repeated fields, indexing, row attributes and owners. Resolve target user names, group names and site codes before writing. Pack whole tables into independent workbooks of at most 500,000 physical rows including the definition and all headers. One definition and one item sheet leave 499,997 data rows for one table. Keep each table whole when using replacement. HQ leaves unmentioned tables alone. Journal per-workbook content digest, affected tables and result. Re-read after uncertain writes before resuming. An unresolved owner can leave a written row with a warning. Treat that result as incomplete. |
| Newly provisioned, proven global and unindexed definition/rows cannot travel losslessly in a workbook | Add a narrowly scoped JSON resource writer to the resources phase. `LookupTableResource.obj_create` accepts the tag, fields, field properties, row attributes and globality. `LookupTableItemResource.obj_create` accepts exact ordered field lists and item attributes and appends its own sort key. This handles, for example, a plain global table tagged `types`, over-workbook-size tables and whitespace or repeated empty values. Write only to a reviewed vacant tag this deployment creates. Record the new table and each appended remote ID and ordered prefix. After a lost acknowledgement require a unique matching prefix and expected tail before resuming. Stop on another writer’s change or ambiguous duplicate. Never clear a pre-existing same-tag table to restart. Verify every row through the detail API before app content. For the manual package, generate the table and ordered rows plus an authenticated, resumable installer using the same create/read-back contract. Keep credentials out of the package. HQ’s own positive request/response witnesses are in `api/tests/lookup_table_resources.py::TestLookupTableResource.test_create` and `TestLookupTableItemResourceV06.test_create`. An unacknowledged table creation without a recorded table ID re-enters the existing named-resource ownership review. Equal contents cannot establish who created it. |
| The source owns facts a carrier cannot represent or Nova cannot verify | Offer a source-managed reference. The project-space admin prepares the equivalent target table and resolves every target principal, and supplies the target’s selected-table export or a worker’s authorized restore for the facts it demonstrates. The review compares table tag, definition, order and values from the API plus supplied indexes/assignments or that particular worker’s fixture. A worker sample proves only that worker. If table-wide assignments cannot be attested, the destination stays incomplete, with the source app usable. Project data also offers an explicit new target design with authored index/assignment choices, a reviewed change with a named effect. Neither action silently replaces source behavior. |

HQ’s `fixtures/upload/{const,workbook,validation,run_upload}.py` and
`corehq/util/workbook_json/excel.py::IteratorJSONReader` define the first carrier. In a direct execution of the
pinned reader a flat cell `" 007 "` became `"007"`, a numbered blank value with property `hin` produced zero
occurrences, and a nonblank numbered value with a blank property could not be reconstructed. Check **every
row**, including missing/empty state and property position, against the representable subset. A table named
`types` aliases the definition sheet in `_FixtureWorkbook.get_data_sheet`. A second sheet of a different name
cannot fix it. The JSON table API has no index setter and its row API has no assignment writer. The JSON
fallback is consequently conditional. Do not send a private table as global or drop an index to make a
destination succeed. A description remains HQ metadata outside the workbook and the device. Name its loss on a
reviewed transfer that replaces the definition.

A plain Nova table adopted by matching a target tag has no HQ origin today. Offer **Use the table from CommCare
HQ** on that table’s Project data page. Enumerate its live mappings, let the editor select the source, show
column/row/distribution changes and every app reading it, then re-read that remote and compare the table
revisions, dependent apps and target mapping under lock. Install the complete copy or source-managed reference
with the chosen origin atomically. Reuse `lib/lookup/managed.ts` and `lib/deployment/managedData.ts` for
hand-back and takeover. A drift stop on publish links here and otherwise retains the existing reviewed discard
action. Discard is available only for a representable authored replacement. It cannot imply preservation of
unreadable metadata. During the historic baseline migration invalidate affected or unclassifiable adopted
baselines so the next publish compares current facts and stops for review. Count every affected mapping and
verify a second scan finds none still treating the old digest as complete.

### 1D. Places and media

Replace the 10,000-place whole-tree boundary in `lib/organization/schema.ts`, persistence,
`lib/deployment/reading/projectData/places.ts` and callers. Use cursor-paged roots/children and indexed
recursive queries for ancestor paths, worker footprints and reverse-owner cardinality. Bind pages to the read
revision. Compare ordered source records by remote ID, use that ID to preserve the Nova place UUID through a
site-code or parent change, and publish parents before children. Store exact external site and level codes and
display names, including case and Unicode where HQ can read them. Distinguish duplicate display labels by their
code/path. Keep the normalized destination lookup index separate. Record both the HQ numeric coordinate value at
decimal(20,10) precision and the exact fixture text required for a string read, including trailing zeroes. Read
metadata as the text `locations/fixtures.py::_get_metadata_node` writes (`str(value)`, absent becomes empty).
Preserve the source observation separately for the API write if conversion loses type. Honor the API fields for
external ID, parent, level, `administrative`, `shares_cases` and `view_descendants`. Unobservable worker and
expansion settings remain explicit setup/defaults. Verify a level or metadata key actually read as an XML name
at its consumer. Model unknown/empty source fields explicitly where HQ admits them.

Remove `places-over-nova-limit`. Split `place-not-holdable` by cause. Additional valid HQ data now comes in. An
inconsistent read (missing parent, cycle or missing level) rereads once and then reports inconsistent source
data. A stored spelling the destination’s own create API would fold, refuse or conflate is usable at its origin.
Show the required destination mapping or setup and verify the mapping before sending app content. Keep scalar
case ownership valid by construction. A rule needing a reverse location hop requires exactly one reachable owner
candidate on each relevant path. Reclassify `owner-rule-needs-one-place` as a named data/configuration conflict
with the affected level and zero/multiple candidates. The user selects an explicit owner rule or fixes the
places in HQ and refreshes. Never choose the first candidate. Check the same invariant on future topology edits.
New-space publish verifies levels first and uses the existing atomic PATCH batches of up to 100 for places the
API can create. Levels require target setup, and an organization managed in HQ remains managed there. Use
`locations/{models,fixtures,util}.py`, `locations/resources/v0_{5,6}.py` and Nova’s `locationResourcePlan.ts`.

For HQ media lift the present 5/10/50 MiB file and 500-file/200 MiB aggregate admission ceilings. Keep Nova’s
direct uploader’s per-kind limits and its format/playability checks. Stream only referenced source media through
authenticated fixed-host reads, count actual bytes, inspect signatures and compare content digests, then stage
completed objects under the receiving Project. Include source revision and path in the review. Stream archive
members and multipart bodies with bounded memory rather than calling `readFile` on the complete set. Split HQ
media batches on path boundaries and check every matched, skipped and unmatched path against
`hqmedia/tasks.py::process_bulk_upload_zip`. One oversized file is an indivisible member. If the target cannot
accept it, name that file, offer the target’s own media upload, re-read the mapped content and require its
digest before marking complete. An origin publish reuses already matched media. No cross-Project digest match
authorizes a read. No signed URL, workbook or restore credential goes in app history, a chat transcript or proof
artifacts.

## 2. Settings Nova owns

The ten `settings-nova-comes-to-own` entries are nonempty build profiles, codes outside Nova’s language
registry, generated-string overrides, required Android packages, case sharing, root grid, the app’s form-menu
grid rule, a menu’s effective grid style, form location capture and the worker-groups fixture. Language
reordering is an additional Step 6 refusal in `lib/deployment/hqChanges/plan.ts`.

### 2A. Case sharing and worker groups

Add a case-sharing switch to app settings and a Project catalog of worker groups with UUID, display name,
whether it shares cases and metadata. A persona can belong to multiple groups independently of its primary and
additional place assignments. A target group selection reads authorized scoped records through HQ’s registered
`api/resources/v0_5.py::GroupResource`, which inherits the name, member IDs, case-sharing flag and metadata from
v0.4. Resolve only the reviewed worker/group bindings. If the key lacks the account-management read, use a
supplied worker-specific restore or ask the target administrator for the binding. Never infer membership from a
group name. Keep group reads separate from configuration of automatic case ownership. An expression can read a
worker’s groups when an app asks for the fixture even with the switch off. Give the expression tree a
worker-groups source with typed access to group ID, name and metadata key/value. Bind incoming declarations by
`jr://fixture/user-groups`, including noncanonical aliases. Quarantine XML and metadata spellings in
`lib/commcare`. Unread declarations remain subject to the existing declaration rules.

Confirm `case_sharing_groups` by the existing deployment privilege path before enabling the switch on a target.
Generate the same conditional entry assertion and owner bind in HQ and local exports. HQ’s
`app_manager/suite_xml/sections/entries.py::configure_entry_module_form` tests the active basic open/subcase
actions. Its advanced branch uses `autoset_owner_id_for_advanced_action`. The corresponding
`app_manager/xform.py::XFormCaseBlock.add_create_block` selects unowned extension, group or individual owner.
Explicit owner updates keep their own action order and exceptions. Assert exactly one group **only** for an
entry for which HQ emits that assertion. With zero or several groups, Preview stops at entry and performs no
submission. For exactly one it persists that group’s ID through the real submission and includes its cases in
the worker restore scope. Keep `(app_id, project_id)` as the tenancy filter for every read/write.

Populate Preview from the same typed group, worker and organization data. HQ’s
`users/fixturegenerators.py::UserGroupsFixtureProvider` emits the group ID, name and metadata.
`users/models.py::CommCareUser.get_case_sharing_groups` includes only case-sharing HQ groups plus case-owning
locations. `CouchUser._get_case_owning_locations` also includes eligible descendants even when the worker was
never directly assigned there. One target setting changes the descendant bound through
`locations/sql_templates/get_case_owning_locations.sql`. Model the two verified delivery rules in the
target/persona projection, using a supplied worker fixture or target-confirmed rule where the API cannot
distinguish them. Use the location group name and metadata projection from
`SQLLocation.case_sharing_group_object`. Preserve the actual fixture ordering/multiplicity for ordered reads and
the exactly-one assertion. Validate both restore variants and a classic non-sharing group that can grant a
lookup row but cannot supply a case owner. Adding/editing personas changes Preview. Publishing never provisions
or changes a real worker or group implicitly.

### 2B. Menus, required Android apps and GPS

| Setting | Authoring, wire, runtime |
|---|---|
| Menu layout | Store root layout, form-menu policy (all lists, all grids or individually chosen) and an optional menu layout. Write `use_grid_menus` and `grid_form_menus` at the app, `display_style` only where the individual choice applies. Keep inactive editor defaults inert. Generate style on the same root and nonroot menu contributions as `app_manager/suite_xml/sections/menus.py::get_module_contributions`, including menus with a parent, forms in the menu above and later group 5 mirrors. Use Core’s `CommCarePlatform.getMenuDisplayStyle` rule for conflicting contributions. Draw both layouts in Preview with working selection and focus. Grid audio plays on Android, while the Web Apps grid omits the audio control. Verify served `cloudcare/.../formplayer/menus/views.js`, Formplayer’s `CommandListResponseBean` and Android’s `MenuActivity`. |
| Android requirements | Store an ordered unique selection from the seven entries in `app_manager/static/app_manager/json/commcare-profile-settings.yml` at this pin. Expose their product names. Map to package IDs only at the CommCare boundary. Write `profile.features.dependencies`, local profile dependencies and corresponding package labels. Retain catalog translations with their existing ownership. HQ’s `Application.create_profile`/profile template and `app_strings.py` apply `APP_DEPENDENCIES`. Confirm the target privilege through existing deployment confirmations before writing, and distinguish losing a privilege from deliberately emptying the setting. Android Preview accepts an installed-package selection and shows the same missing dependency stop as `ApkDependenciesUtils.performDependencyCheckFlow` before opening the app. Web Apps ignores this requirement. |
| Location capture | Own the app-wide switch on ordinary apps and the per-form switch for basic and advanced forms. Each can be edited in its owning settings. Keep Connect’s existing requirement that all forms capture location, with its published change disclosed when a source Connect app has the setting off. Read and preserve a form’s independent setting where HQ’s editor retains it. Effective capture on supported builds is the app switch OR the form switch (`app_manager/models/forms.py::get_auto_gps_capture`, `feature_support.py::enable_auto_gps`, floor 2.14, below Nova’s 2.57 minimum). Generate the metadata location node, geopoint bind and `orx:pollsensor` exactly where HQ’s `xform.py` generates them. Android’s `PollSensorAction` and `PollSensorController` own capture and failure. Keep the ordinary geopoint-question branch separate. Android Preview uses an explicit simulated device location or an unavailable sensor outcome, including the resulting submission metadata. Web Apps ignores automatic collection. Verify the resulting Connect visit evidence separately from a worker’s point answer. |

Show the app and form switches’ effective result beside their controls, use existing platform notices and keep
the `connect-location-capture` feature accurate. Remove the ordinary app’s kept GPS row and write explicit false
when clearing an owned setting. A missing top-level key on update can keep the previous HQ value. Retain
`connect-app-captures-location` for the exact remaining normalization. Keep Android logos, app-level practice
worker, runtime catalog wording and customized language display names in `KEPT_AT_HQ` with their current
archive/Preview explanations. They already pass the kept-setting contract. The new generated-string overrides
below name individual app-owned output. The ambient language-display-name row retains its present scope.

### 2C. Languages and generated wording

Widen the domain language identity with a tagged **project language** carrying an immutable local identity and a
unique external spelling. Keep existing registered language tags and their translation keys readable without
conversion. Use a distinct namespace for the new map/URL key, independent of a display label. For HQ codes
within `languageWireCodeSchema` that do not name a living individual language, or that would give two codes the
same registered identity, retain each wire code exactly once. Reuse a previously bound identity before
consulting order. On first read without bindings map a uniquely recognized registry identity once, preferring
its existing canonical wire spelling in collisions, with a deterministic code-spelling tie-breaker. Remaining
codes become distinct project languages, so a reorder cannot change identities. Duplicate exact codes and codes
HQ’s Languages editor will not save retain their existing refusal. In Nova’s language picker a project language
is identified by its verbatim code. Show a derived display name only where one is known. Allow manual
translation and a local direction choice where its registry cannot supply one. Keep an HQ language-selector
wording override in the existing target overlay. Automated translation needs a reviewed language
identity/descriptor before sending content to a model. No invented registry match.

Add an anchored move-language mutation and matching Builder, SA and MCP actions. Moving a language first makes
it the runtime default. Making a different language first must preserve canonical source strings, stored
translations, status, fingerprints, wire codes and profile references. A birth chooses
`lib/commcare/reader/languages.ts::readingSourceCode` using its current evidence (the app name and system text).
The first language is the default and only the fallback source. On re-read, preserve an equally admissible
incumbent source through the resolver/canonical rule. If the actual source changes, rebase from per-language
effective texts atomically and prove the resulting emission, including an old-source-only string. Extend
`diffDocsToMutations.ts` and remove the `languages-reordered` hold only when reorder plus edit, add, drop and
default changes reproduce the endpoint. Reject removal of a profile’s last language until the same mutation
batch repairs the profile.

For an effective override of a generated string, store language identity, the generating slot’s stable owner
identity and a closed output role (for a split output, the particular generated string). Register those roles
beside the generator and use them for both reverse lookup and forward projection. Extend
`lib/commcare/reader/generatedTranslationKeys.ts`, `appStringKeys.ts`, `appStrings.ts`, the translation
inventory and Preview. Emit the override last under the key that the *current* owner positions generate.
Deleting an owner deletes its overrides, moving it recomputes the outgoing key, and editing an unrelated sibling
text never retargets the override. Keep the current fold for a single authored text whose outputs agree and
`translation-overrides-folded` for that class. A missing, blank or equal entry stays inert. Distinguish override
of a constant, one-of-many outputs, catalog text, non-existent generated key, prefix lookalike and the
dependency-name/catalog overlap. Offer generated wording under its owning control and Languages, with “Use
default wording” removing the override. Verify secondary locale fallback and the locale-file grammar.

### 2D. Installation profiles and target ownership

Hold named profiles by UUID with a nonempty ordered subset of app-language identities and an optional
practice-worker *role/binding*. Preserve the source profile’s key in the deployment identity map. A profile on
another space must bind its own practice worker. Newly added app languages stay outside a profile until the
author includes them. The default installation remains the app’s language order. Offer a profile picker for
Preview, downloads and the build guidance, and apply the selected subset to the default locale, app strings,
XForm/itext and profile resources. `app_manager/models/applications.py::get_build_langs/get_practice_user_id`,
`app_manager/app_strings.py::_create_custom_app_strings` and `suite_xml/sections/resources.py` consume the
selected profile. A local device build that requires a practice restore directs the user to the named profile’s
build at HQ, which owns that worker’s restore. A normal all-language device archive stays available. No generic
archive contains a private worker restore.

Use the app source’s full profile definition including name, key, sequence and practice worker, extending
`lib/commcare/hq/appSource.ts::readBuildProfiles` which presently projects only the needed subset. Distinguish
an empty profile collection from an individual profile with no languages, which HQ cannot build when it selects
`langs[0]`. The create import carries the target-bound desired profiles, including on Nova’s resource-first app
shell. Preserve desired profile IDs for later install/update and verify them from the new app. In-place import
excludes `build_profiles` in `ApplicationBase._update_excluded_fields`. HQ’s own
`app_manager/views/releases.py::LanguageProfilesView` replaces the profile map in an authorized browser edit and
checks the plan and practice user. A file sent as an update cannot do that edit.

On a mismatch give the person the exact desired names, language orders and practice-worker bindings, plus the
target app’s Language Profiles page. Record the reviewed target state. On retry read the full profiles,
correlate new target-generated keys only via a unique reviewed binding, and advance when the complete observed
profile set agrees. For adding a language not yet present at HQ, send a content update containing that language
only after checking existing profiles remain valid and recording this incomplete operation. For removing a
language still named at HQ, first have the person remove it from the target profiles, then verify and send
content. For a replacement with both dependencies, publish an intermediate **safe language superset** with all
required text and stable IDs, then complete the target profile edit and publish the final app. Persist and check
the intermediate source digest with ordinary drift safeguards and show the exact phase on retry. Mark the
deployment uploaded only after final read-back. Enforce `build_profiles` privilege and the existing preflight on
every transition. This protocol replaces the obsolete claim that an ordinary overwrite publishes a profile edit.
The formerly empty-profile kept row joins the owned collection. Do not compare profiles using HQ’s
`BuildProfile.__eq__`, which skips the name.

## Authorization, adoption and cutover inputs

- Use the existing browser Project/app edit authority and `lib/mcp/scopes.ts` HQ Import/HQ Write grants. An
  operation changing management needs both HQ grants and Project edit. A read never authorizes a target
  mutation, creating an account or changing membership. Recheck scope inside the authoritative write
  transaction. Bind every confirmation and supplementary input to the actor, Project, source/target tuple,
  source digest and the reviewed revisions. Permission loss or different target before commit returns a fresh
  review.
- Reuse current immutable fold baselines and external identity agreements. Extend `hqCanonical`/deployment
  baseline projection with observed-vs-unobserved facts and stable IDs. Bind a page cursor to the authorized
  revision. Join remote reads outside database locks, validate versions and source digests on accept, and commit
  the new app/copy/edges atomically. Discard temporary objects and private staged files on cancellation, failure
  and expiry. Extend SQL integrity for shared lookup definitions, edges, bigint accounting and renamed place
  identities. Existing scalar cells keep their exact fixture emission, including the old projection of a missing
  value. Compare every migrated table with the old emitter before removing the old representation.
- Scan each active deployment of an existing app for settings that become Nova-owned, including profile
  subsets/IDs and the ordinary app’s GPS value. Record per-target facts and digests before writes. With no
  active deployment use current Nova/HQ defaults. Where all verified targets agree, adopt that setting. Where
  they disagree, use HQ’s default and name each affected target’s old and intended value on review, including an
  explicit empty profile collection and any dependent practice binding. An unreachable target is unknown.
  Complete the scan with working credentials or keep that target fenced from writes until it has an observed
  baseline. A fresh read verifies the reviewed target again before first publish. Never default an unreadable
  target silently. Existing languages/wire spellings and identities survive. Old personas have no additional
  group memberships, old app test expectations use their recorded runtime version. Include these transforms and
  their rehearsal in the roadmap’s single applicable cutover.

## Inventory ownership

Each full entry ID is the manifest area followed by a slash and the exact slug below. The three place
circumstances and language ordering have no inventory slug.

| Implementation | Manifest area | Owned slugs |
|---|---|---|
| 1A | `case-search` | `itemset-refs-to-item-attributes-attr-or-property-qualified` |
| 1A | `questions` | `itemset-refs-to-attr-or-property-qualified-fields` |
| 1A–1B | `expressions-and-data` | `tag-or-field-name-holding-a-period`, `tag-equal-to-an-instance-name-commcare-owns`, `tag-or-field-name-with-non-ascii-letters`, `fields-properties-and-multi-valued-cells-name-lang-en-name-name`, `item-attributes-and-per-row-attribute-values`, `absent-field-vs-zero-values-vs-empty-string` |
| 1B–1C | `expressions-and-data` | `tag-types`, `is-global-false-row-owners-user-group-location`, `fields-is-indexed`, `table-or-row-count-beyond-nova-s-caps-5-000-rows-250-columns-64` |
| 1D | `expressions-and-data` | `an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app` |
| 2A | `application-and-settings` | `39-hq-case-sharing` |
| 2A | `expressions-and-data` | `groups-jr-fixture-user-groups` |
| 2B | `application-and-settings` | `31-features-dependencies`, `46-hq-use-grid-menus`, `47-hq-grid-form-menus-none-all-some` |
| 2B | `forms-and-case-writes` | `auto-gps-capture-form` |
| 2B | `menus-and-case-lists` | `module-display-style-list-grid-read-when-grid-form-menus-some-on` |
| 2C | `application-and-settings` | `langs-code-nova-s-language-registry-cannot-name`, `translations-generated-key-anything-else` |
| 2D | `application-and-settings` | `build-profiles-non-empty` |

## Exit evidence

1. Expand `proof/hq-apps/hq-{lookups,media,places,languages,kept-settings}` and add HQ-authored settings forms.
   Record exact entry IDs, updates to standing/claim and independent Python value classifier for each of the 13
   + 10 inventory rows. Relocate every owned variant to an admitted base with proofs 1–6 or split its exact
   source-only/portability class with an explicit observed outcome. Withhold HELD for any operation claimed to
   preserve a fact no reader established. Record observed resource IDs/digests, worker-scoped visible rows,
   indexes, cells, menu style/audio, selected languages, emitted strings and actual case owner. Include an HQ
   editor edit of each new slot or resource, reviewed bring-in of that change, next publish and fresh read-back.
   A resource edit belongs to its own manager and revisions, not a fabricated blueprint mutation.
2. Show own-space publish makes zero writes to HQ-managed resources. Exercise a portable table in a vacant
   second space, JSON-created `types`, a prepared rich target with independently compared data, an unavailable
   source-only target, a partial workbook upload, an unknown row-create acknowledgement, and the absence of a
   source-table write after a concurrent hand-back. Test two worker fixtures with disjoint assignments through
   endpoints, cache, exports and search. Use actual HQ fixture provider, upload validator/reader and native
   Core. Test sizes on both sides of every old cap, the exact 500,000/500,001 physical-row boundary and a table
   with one row too many for one workbook. Check peak memory stays bounded as total members/rows rise. Keep very
   large generated rows and media temporary. Test 10,001 places with a small worker footprint,
   renamed/reparented source place, mixed case codes, unsupported target parentage, and zero/one/two possible
   owners.
3. Exercise zero/one/multiple case-sharing groups with explicit owner, unowned extension and auto-owner paths.
   Compare served HQ/Web Apps and Android grid behavior, missing/installed Android dependencies, app/form GPS
   combinations and both platform outcomes, plus profiles with different first languages. Observe a profile-only
   rename, a missing target practice worker, inaccessible target, changed source mid-review, and a language
   replacement across an interrupted profile edit. Demonstrate new-source, local archive and live HQ decisions
   separately.
4. Update platform rows and Preview cells, `KEPT_AT_HQ`, inventory, public guides, nearest contracts, tool
   catalogue, plugin guidance and versioned model/runtime context with their respective changes. Regenerate gate
   relationships for `lookup_tables`, `locations`, `case_sharing_groups`, `app_dependencies`, `build_profiles`
   and `enable_auto_gps`. Search’s existing project-space and sync gates still apply to a lookup-backed search
   prompt. The proof lane checks the exact review/first-publish changes, including the retained Connect GPS,
   generated-text fold and flat-location-setting entries. Independently deny a missing privilege or a worker’s
   missing assignment to demonstrate sensitivity. General app-body or malformed-source stops remain specific.
   Large paginable lookup data must no longer hit the ownerless `lookup-data-too-large` just because an
   aggregate list was materialized.
