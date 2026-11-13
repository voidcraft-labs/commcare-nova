# Step 7: The rest of the model (outline)

Step 7 is what is left when step 6 is done: every concept an HQ app can hold that Nova's model does not
hold yet, in eight groups. Bringing in what someone changed in CommCare HQ after an app came in is built
in step 6 (its part 15, `6-bring-in/15-changes-made-in-commcare-hq.md`), so no group here holds it. Each
group below is planned in full when the group before it exits, against the code as it then stands. This
file is an outline: a decision already taken is stated, an open question is a question with what is
known, and nothing is designed here. A slot name the code does not hold yet (`Form.caseSelections`,
`Module.mirrorOf` and the like) is the research's name for it
([`inventory/README.md`](../../research/2026-09-26-hq-round-trip/inventory/README.md), "HELD-NEW
concepts"), and it binds nothing: a group's full plan names its slots.

It is written with step 6's plan (`6-bring-in.md`, with its parts in `6-bring-in/`), and "part NN"
below is a part of that plan. The plan leaves `docs/plans/` when step 6 ships, as every plan does. From
then "part NN" means that part as it stood in the last commit of `main` that holds it, which git keeps
(`git log --diff-filter=D -- docs/plans/hq-round-trip/6-bring-in.md` names the commit that removed it).
The change that removes the plan rewrites no citation here, and this file links to no file of the plan,
so no link breaks when the plan goes. What step 6 built is read from then in the code and in the
architecture documents and subtree `CLAUDE.md` files its parts write.

CommCare facts here are read at step 6's pins: commcare-hq `d6c6e16d8ae1`, commcare-core
`8e9ba8d908e9`, commcare-android `7a5584475580`, commcare-connect `046c7fd78081`, formplayer
`24383ac71bfb` and Vellum `01215f251c57`. A group's full plan reads each fact again at the pins that
stand when it is written. Nova is cited as `path::symbol` at `main` `1f103305`, and a file or symbol
step 6 creates is cited with the part that plans it.

## The groups, and the order

Each group is cut by what one page of CommCare HQ writes, so a group makes whole apps come in, and each
has an id the manifest holds. From step 6 every HELD-NEW entry names its `owner`, one of
`lib/publish/hqFindings.ts::STEP_7_GROUPS` (part 01, section 2.3), and the manifest test fails an entry
without one. So the manifest is the list of what each group owns: a group's entries are the entries of
`lib/commcare/surface/entries/` whose `owner` is its id. Part 01's Appendix A.1 assigns every entry its
owner and its subject, part 01's section 2.3 states how many each group starts from, and the manifest
test computes that count. This file copies neither the list nor the counts, so an entry a check of
step 6 adds, with its owner, changes nothing here. A group's section below says in words what the
group holds, and names an entry only where it says something of that entry.

One thing of step 6 does change this file. Where step 6 itself comes to hold a concept a group below
names, under the top-level file's rule that a starter app must come in (`6-bring-in.md`, "Checks before
the merge"), the change that builds the concept takes it out of that group's section.

| | Group | Id |
|---|---|---|
| 1 | Project data at CommCare HQ's size | `project-data-at-hq-size` |
| 2 | Settings Nova comes to own | `settings-nova-comes-to-own` |
| 3 | How a question looks | `question-display` |
| 4 | Case lists and case details | `case-list-and-detail` |
| 5 | Menus | `menus` |
| 6 | Case search | `case-search` |
| 7 | Forms and case management | `forms-and-case-management` |
| 8 | What a form holds | `xform` |

**The order.** The groups are listed in the order `STEP_7_GROUPS` gives their ids. Project data and app
settings stand first because they are facts of a project space and of a whole app, not of one menu or
form, and after them a group that builds something another reuses stands ahead of it. The order is a
default. Nothing measures it and nothing reads a count to set it, and the person who plans step 7 may
take the groups in any other order.

**Work that groups share** is built once, by the first of those groups in the order, and the others
reuse it. Where the groups are reordered, the first of them still builds it.

- *Names with letters outside ASCII.* A case property in a case write (`forms-and-case-management`) and
  a lookup table's tag or field (`project-data-at-hq-size`) need one name token and one table of the
  characters every declared platform reads, generated and proven on both, with a reference text that
  admits them. `project-data-at-hq-size` builds the token and its table and
  `forms-and-case-management` reuses it (part 04, section 2.3).
- *A relation whose case type the catalog knows.* The catalog holds one `parent_type` for a case type,
  and `parent` is the one index whose destination Nova infers from it
  (`lib/domain/expression/relationDestination.ts`; `lib/domain/expression/CLAUDE.md`). Three things
  wait on an index whose case type the catalog knows. A read through an index other than `parent` that
  names no case type, `#host` among them (part 08, section 6.3), which a list's column or filter, a
  display condition and a parent menu of another case type each meet. A preload or a case write
  through an index whose case type the app does not state (part 07, section 3.7). And a child case
  type under more than one parent (the research's "Also held" list), since every walk through an
  index resolves through that one `parent_type`. `case-list-and-detail` builds it, and `menus` and
  `forms-and-case-management` reuse it.
- *Functions in a record slot.* A function the record rule set gives no arm of its own waits, by the
  slot's own entry: `case-list-and-detail` for a list's filter, a calculated column and a sort
  calculation, `menus` for the two display conditions, `case-search` for the search slots and `xform`
  for a choice list's filter (part 08, section 8.1). A list's slots are read by Postgres too, which
  decides which rows a list holds, and Core's coercions are not Postgres's: in commcare-core's
  `org/javarosa/xpath/expr/`, `FunctionUtils.java::toNumeric` reads date text as a day number,
  `XPathStringLengthFunc.java::evalBody` counts UTF-16 units and `FunctionUtils.java::normalizeCase`
  lowers in the device's locale. So each function needs a typed admission rule and a proof against
  Core before a slot may depend on it, and a function's rule and proof are one piece of work across
  the four.

## What every group lands with

A group holds a concept the way step 6 holds the concepts a plain app carries: as a complete Nova
feature (domain, validator, both emitters, Preview, builder, Solutions Architect and MCP, public docs,
platform row, proof), with its reading. The rules below bind every group.

- **The reader reads it in the change that emits it.** The bar of step 6 holds: the reader admits
  exactly what the gate admits, and re-reading Nova's own emission of a document gives `canonDocument`
  of that document (proof 6; part 09, section 9; part 14, section 5). An entry flips to HELD in the
  change whose emitter and reader first make its wording true, with its inventory row, and there it
  loses `subject`, which only a HELD-NEW or REFUSED entry holds, and `owner`, which only a HELD-NEW
  entry holds (part 01, sections 2.2, 2.3 and 2.6). Its claim joins the reader's claims, which a test
  binds to the manifest (part 06, section 4.2), and a use Python decides gets its value-class reader
  for parity (part 14, section 8).
- **A change to it in CommCare HQ comes in.** Step 6 brings a change made in CommCare HQ in as the
  difference of two readings, written as Nova mutations (part 15, section 2). So a concept a group
  holds has the mutations `lib/doc/diffDocsToMutations.ts::diffDocsToMutations` needs to reach its
  slots, and a lane document whose edit to that concept in CommCare HQ is brought in and published
  back (part 14, section 6.6).
- **Platform rows.** From step 4 every HELD entry read per platform whose readings differ belongs to a
  feature of the platform table (`lib/domain/platforms.ts::PLATFORM_FEATURES`, its entries in
  `lib/commcare/surface/platformFeatureEntries.ts`) or to its ambient list (`AMBIENT_PLATFORM_ENTRIES`,
  an entry no author choice reaches, with its reason), held by
  `lib/commcare/surface/__tests__/platformFeatures.test.ts`, and each of its cells that reads neither
  `runs` nor `not-applicable` has a row in Preview's cell table
  (`lib/preview/__tests__/platformCells.ts`, held by `platformCells.test.ts`). So a group that flips an
  entry with such a reading adds its feature row and its Preview cells in the same change, or CI
  fails. A feature that reads `unavailable` on a platform also carries its refusal copy, a fixture in
  `lib/domain/__tests__/platformFeatureFixtures.ts`, its builder offering disabled with
  `platformPickerLine`, and a cause word in `lib/notices/migrationNoticeCopy.ts::PLATFORM_CAUSE_WORDS`,
  whose test holds the record to every feature that reads `unavailable`. A new or changed row changes
  the guide's generated platform sentences, so it moves `MODEL_CONTEXT_VERSION`. An ambient entry whose
  concept a group makes an author's choice leaves the ambient list for a feature, since its reason no
  longer holds.
- **What a first publish changes shrinks.** Where a group holds exactly what step 6 could only declare,
  the entry of `FIRST_PUBLISH_CHANGES` leaves in the same change (part 09, section 11), with its row
  of the rewrite registry where it has one (part 08, section 2.3) and its rows of the lane's register
  file (part 14, section 9). Three entries of part 09's section 11.2 are named below, all under
  `case-search`: `search-today-device-day`, `search-filter-joined-to-list` and
  `search-restates-list-filter`. One stays through its group: `sort-rule-kept-as-hidden-column`
  changes no behavior, and a sort rule is the `sort` slot of its column (part 10, section 2.2), so
  `case-list-and-detail` holds a sort's label on the hidden column that entry keeps; the entry leaves
  only if that group's plan gives a sort rule a place apart from any column. A group's full plan reads
  section 11.2 whole and names every other entry its concepts make exact.
- **Coverage.** Every manifest entry is in exactly one of the lane's sets (base-exhibited,
  variant-exhibited, exempt; part 14, section 7.5). An entry a group holds moves from its variant to a
  base: an HQ-authored app that holds it comes in, republishes, and passes every proof.
- **One cutover per group, only where a stored shape moves.** Each group is its own step for the
  cutover rule of [`README.md`](README.md) ("Rules every plan follows"). Step 6 migrates no document. A
  group whose concepts are optional slots or wider grammars migrates none either; a group that changes
  a stored shape migrates all of its changes in one cutover, with its scan first.

**Exit, for every group.** No HELD-NEW entry names the group as its `owner`. Each entry it owned is
HELD and exhibited by a base that comes in, republishes and passes proofs 1 to 6, or the group's full
plan re-cut it to another standing with the evidence at source. No circumstance of
`lib/publish/hqFindings.ts::CIRCUMSTANCE_STANDINGS` carries the group as its owner, or the group's full
plan keeps one with its reason (part 01, section 8.3). Neither condition waits on a person: once no
entry and no circumstance names the group, no reading can raise a not-yet finding of it. Each group
below adds what is its own.

## 1. Project data at CommCare HQ's size (`project-data-at-hq-size`)

Lookup tables, places and media as large and as rich as a project space holds them.

**Concepts.** What a lookup table holds beyond one text value a field: field properties and cells of
several values, row attributes, rows that go only to their owners (a table that is not global), an
indexed field, the two cell states a device tells apart, and a table tagged `types`. Choices and Search
field choices read from a row's attributes or a field's properties. A tag or a field name with a letter
outside ASCII, with a period, or equal to an instance name CommCare owns. Sizes: a table over Nova's
caps (`lib/lookup/constants.ts`) or the tables of one app over what one `.ccz` carries
(`lib/commcare/lookup/fixtures.ts`: 10,000 rows, 100,000 values, 16 MiB), a media file over Nova's cap
for its kind (`lib/domain/multimedia.ts::ASSET_SIZE_CAPS_BYTES`: 5, 10 or 50 MiB for a picture, a sound
or a video), and an app over 500 files or 200 MiB (`MAX_MEDIA_EXPORT_ASSETS`,
`MAX_MEDIA_EXPORT_BYTES`).

Three circumstances carry this owner and no entry, each a fact of a project space's data that no
manifest entry names (part 01, section 8.3): `places-over-nova-limit` (more active places than the
10,000 Nova holds for an app), `place-not-holdable` (a level's code, a place's site code, name,
coordinates, parent or value outside what Organization holds) and `owner-rule-needs-one-place` (part
11, sections 11.2, 11.4 and 13.2). The group's exit counts them with its entries. An app body over the
bring-in's byte bound is the circumstance `too-large`, which carries no owner: it is a plain refusal
with one cause, and no size this group is asked to design for (part 01, section 8.3; part 05, section
3.3).

**What step 6 builds toward it.** Only the tables an app reads come in, each a copy managed in CommCare
HQ, every column text and every cell CommCare HQ's string as it stands; the managed fact lives on the
Project table; a publish to another project space creates the table from the copy (part 11, sections 5
to 9). A table or a file over a cap, and content Nova cannot hold, is a finding raised from the
reading, never a gate refusal after the birth (`lookupTableFindings`, `lookupFixtureBudgetFinding`,
`mediaBudgetFinding`; part 11, sections 4.3 and 5.3). The name grammar a tag and a field take, hyphens
and an upper-case `XML` start among it (part 04, section 9). The two lookup reads and what each serves
(part 05, section 10).

**What it decides.**

- Which caps move, and to what. Known: HQ caps one workbook upload at 500,000 rows over all its sheets
  (`fixtures/upload/const.py::MAX_FIXTURE_ROWS`), and the research ("Reference targets") has Nova's
  per-table caps grow to hold any table HQ holds, a push split into workbooks under that cap, and a
  table too large for one workbook referenced and not adopted. Open: whether a table Nova cannot copy
  stays managed in CommCare HQ with no copy, and what Preview then shows.
- How Nova learns one table's row attributes. Known: the read that returns one table's rows serves no
  attribute, and the read that serves attributes returns every row of the project space (part 05,
  section 10.2).
- What holding an indexed field means. Known: no read an API key gives returns a field's indexed flag, a
  description or row owners (part 11, section 5.4), a managed table is never pushed to its own project
  space so none is erased there, and "Manage in Nova" says a push clears the first two
  (`LOOKUP_DISCARD_NOTE`). A table's description stays outside every step: the research ("Reference
  targets") finds no workbook column for it and no API that sets one once a table exists.
- The workbook that could carry a table tagged `types` (part 11, section 5.3).
- Whether a managed table's columns ever take a type. Known: text is the one type under which a re-read
  of what Nova wrote equals what Nova holds (part 11, section 5.2).
- Which place shapes Organization comes to hold, and the place limit. Known and outside this group
  unless a read comes to serve them: a level's worker and expand settings, which take Nova's defaults
  and are said in Organization and the review (part 11, section 11.3).
- How a deployment that already holds richer content takes it in. Known: a deployment that adopted a
  table carrying content Nova's model lacks stops at publish today (`hq_table_content_unsupported`,
  `lib/deployment/CLAUDE.md`), and the research (defect 5's fix) has this group's cutover clear that
  table's recorded baseline, so its first push stops at the drift check and offers to bring CommCare
  HQ's field properties, attributes, owners and globality in, or to discard them. Decided: that stop
  keeps the one answer step 6 gives it, to publish over the change, which is the discard, and
  CommCare HQ's version is taken on the table's page, which the stop's item names. Step 6 does exactly
  this for a table that came from CommCare HQ, with "Let CommCare HQ manage it again", which takes
  CommCare HQ's columns as well as its rows (part 11, section 9 and Departure 7). A second answer at
  the stop is not planned ("Not planned", below), and this group does not wait on one. Open: how the
  page of a table made in Nova offers CommCare HQ's version, since a table that adopted CommCare HQ's
  by its tag has no origin to hand back to (part 11, sections 6 and 9).

**Exit.** A base that reads tables at each cap, with each kind of content, and its places comes in; a
publish to its own project space writes none of them, and a publish to another creates them whole.

## 2. Settings Nova comes to own (`settings-nova-comes-to-own`)

The app settings that change what a form asks or stores, who owns a case, or what a menu looks like, so
that Nova must hold them and cannot leave them at CommCare HQ's value.

**Concepts.** Case sharing (`caseSharing`): a new case's owner comes from the worker's case sharing
group, HQ's build adds the `groups` instance and an entry assertion, and form logic may read the
worker's groups (`instance('groups')`), a read Nova refuses at parse today
(`lib/commcare/xpath/formPathBinding.ts`, reason `groups-held`). The read means the groups case sharing
gives a worker, which HQ fills from each assigned location whose type shares cases and from every HQ
group with case sharing on (`users/fixturegenerators.py::UserGroupsFixtureProvider.__call__`,
`users/models.py::CouchUser._get_case_sharing_groups_for_locations`,
`CommCareUser.get_case_sharing_groups`): state of the project space that Preview cannot show truthfully
until Nova holds the setting. Grid menus (`menuStyle`: the first menu, every form menu or some, and a
menu's own style). A form's own location capture (`Form.autoCaptureLocation`). Android apps the phone
must have. Build profiles as part of the app Nova holds. A language whose code Nova's registry cannot
name. Wording changed through a key CommCare HQ generates, where Nova holds no slot for that text. The
order of an app's languages as something a person sets.

One concept of this group is no entry: the order of an app's languages. No mutation orders languages
(`lib/doc/mutations/app.ts` holds `relabelSourceLanguage`, `addLanguage`, `removeLanguage` and
`setDefaultLanguage`), so step 6 holds back a reorder made in CommCare HQ and says so (part 15, section
5.3). With an order a person can set, such a reorder comes in.

**What step 6 builds toward it.** The kept test and its table
(`lib/commcare/surface/keptAtHq.ts::KEPT_AT_HQ`; part 01, sections 4 and 5): fifty rows, each a thing
Nova leaves at the project space's value, with what the `.ccz` does, what Preview does and what a first
publish elsewhere does, and `TargetFacts`, the typed projection of a deployment's baseline that the
`.ccz` and Preview read (part 01, section 6). This group's app-level entries are the ones that failed
that test, each with the clause it failed (part 01, sections 3.7, 4.2 and 4.3): case sharing changes who
owns a case Nova's forms create, a grid needs Preview to draw it, a dependency stops the app opening, a
profile's languages fall out of step. Step 6 stops the harm that last one had: a publish reads the
app's build profiles and stops before it writes anything where one names a language the app no longer
has (part 01, section 7.4). Holding the profiles is this group's. A generated translation key that only
overrides one text Nova holds is folded into that text (part 01, section 7.1; part 06, sections 6.5
and 16.5).

**What it decides.**

- The stored shape of each setting and its cutover. From the research's "Identity": where a step makes
  Nova own a setting its publishes left at CommCare HQ's value, that step's cutover reads each existing
  deployment's current value and stores it in the document, and where an app's deployments disagree it
  stores CommCare HQ's default and names each deployment whose next publish changes the value.
- Which kept settings Nova comes to own, if any. Known: nothing refuses an app over a kept row, so none
  blocks a bring-in. A kept row that only states a difference is what owning would retire: a `.ccz`
  carries no Android logo, no practice worker's restore and none of CommCare HQ's catalog text
  (`kept_android_logos_absent`, `kept_practice_worker_absent`, `kept_ui_text_falls_back`; part 01,
  section 5). The research's concept list gives this group typed slots for them (`appSettings`,
  `androidLogos`, `uiStringOverrides` with `uiStringCatalogKeys`, per-language display names), and
  step 6 keeps each at CommCare HQ's value instead (part 01, sections 3.6, 4 and 7.2). A setting leaves
  `KEPT_AT_HQ` only in the change that makes Nova its author everywhere. Were display names to become
  an author's choice,
  `application-and-settings/translations-lang-code-language-display-names-equal-to-the-label` leaves the
  ambient list for a feature. The platform declaration is step 4's (`appSettings.runsOnlyOn`) and never
  this group's.
- `Form.autoCaptureLocation` against the app-level key. Known: the effective value is the form's or the
  app's (`app_manager/models/forms.py::FormBase.get_auto_gps_capture`); from step 6 the app-level key
  is held and derived on a Connect app and kept elsewhere (part 01, section 3.6), and step 4's feature
  `connect-location-capture` names it.
- Whether Preview draws a grid, or says it does not.
- How a dependency is held when HQ writes it only under a plan privilege no API key reads (part 01,
  section 4.2).
- How an order of languages is held and set, and what a reorder does to the source language. Known: a
  reading's source language is its first language (part 06, section 6.3).
- Its platform rows: a form's location capture (ignored on Web Apps), grid menus (a grid's audio is
  ignored on Web Apps), Android app dependencies (ignored on Web Apps).

**Exit.** A base with case sharing on, grid menus and a form that captures location comes in, and each
setting Nova now owns publishes to a second project space as the person set it.

## 3. How a question looks (`question-display`)

The choices an author makes in the form builder about how a question is drawn, the media that differs by
language, and the label forms beyond text.

**Concepts.** The typed display vocabulary beyond the Phone Number question: each thing an author can
choose about a question's display as its own typed setting on exactly the kinds whose control reads it.
Part 03's table (section 2.4) shows the shape has a place for every entry, under key names that bind
nothing: further keypad values, a width, address lookup with its broadcast and receive topics, a hint
as a placeholder, barcode scanning on open and an editable scan, a choice list's layout, columns,
advance and match, a calendar, a 12-hour clock, a map picker, a capture's source, recorder and overlay,
selectable text and a banner on a label, a group that is compact, collapsible or bordered, questions
per row and alignment. Media that differs by language on a label, an option, a menu and a form
(`localizedMedia`). The label forms (long text, inline video, a QR code, speech). A translation that
shows other values than its source text.

**What step 6 builds toward it.** The rules every display setting follows, which bind this group and
which it does not change (part 03, section 2.1); the registry
`lib/domain/fieldDisplay.ts::FIELD_DISPLAY_SETTINGS`, which the platform detector reads, so a new
setting needs no detector (part 03, section 2.2); and the one writer of `appearance`,
`lib/commcare/xform/appearance.ts::fieldAppearance` (part 03, section 2.3), whose token table the
reader reads backwards (part 06, section 9.2). So a setting here is a registry row, a schema key and a
token row, with no migration. A media reference that is the same in every language is held as the one
shared slot (part 01, section 3.5), and a media file keeps CommCare HQ's path per deployment (part 10,
section 4).

**What it decides.**

- Each setting's key and values, under part 03's rules. Where CommCare reads two tokens differently by
  their order, each order a platform reads differently is its own value or the reader's finding (rule
  4). That rule decides the three entries part 03's table gives no setting of their own:
  `questions/multi-token-strings-e-g-minimal-hint-as-placeholder-signature-2`,
  `questions/a-multi-token-string-holding-tokens-no-runtime-reads-on-that` and
  `questions/a-single-string-no-row-names-that-holds-values-android-matches`.
- A reading that holds only under a target gate needs an arm step 4's platform table lacks
  (`lib/domain/platforms.ts::PlatformBehavior` gives one reading per platform): `questions/text-address`
  runs on Web Apps only under `CASE_SEARCH_ADVANCED` and the `geocoder` privilege, and is unavailable
  there otherwise.
- The stored shape of per-language media, for every carrier at once: labels, options, menus, forms, and
  the Register action's icon and spoken label, which step 6 holds as one image and one sound for every
  language (part 02, section 11.8). Each per-language slot joins
  `lib/domain/mediaRefs.ts::walkAuthoredAssetRefs`, so step 4's acceptance by declaration
  (`lib/media/platformPlayback.ts::unplayableReferences`, the commit kernel's media admission and the
  export rule `MEDIA_FORMAT_NOT_PLAYED`) judges each file on every platform the app declares.
- How a translation whose shown values differ from its source text is stored (part 06, section 12.5),
  given that prose parts hold identity and a changed shape re-fingerprints translations.
- Its platform rows. A display setting is something one platform draws and the other may not, in
  both directions: among this group's entries are ones that read `ignored` on Web Apps and run on
  Android, and ones that read the reverse. Each entry whose readings differ takes a feature row
  with its Preview cells, or a place on the ambient list, in the change that flips it ("What every
  group lands with", "Platform rows"). Which entries those are is read from the manifest when the
  group is planned: the entries whose `owner` is this group's id and whose `platforms` readings
  differ. This file copies no count of them.

**Exit.** A base per palette question with each appearance HQ's form builder offers comes in, and a
multilingual base with media that differs by language republishes with each language's file.

## 4. Case lists and case details (`case-list-and-detail`)

What CommCare HQ's Case List and Case Detail pages write.

**Concepts.** Tabs on the case detail (plain tabs, and data tabs over child cases or an expression, with
a tab's display condition). Tiles: the `icon_text_grid` template with a column's slot, the case detail
laid out as a tile, a persistent tile from another menu, a pull-down tile, persistent case context. A
lookup from the case list into another Android app, with the `fingerprintquery` read it supplies. The
remaining column kinds: address, distance, the map layers, a clickable icon, conditional text, an image
map keyed by plain values or by conditions, the wider interval column and the flag with no list header,
a plain column that shows a select's raw value, the owner's name, a column over the worker's record, a
property column read through a relation, a markdown column outside the link shape, an authored
translated expression, authored alt text. Sort settings: an authored comparator, distance, a sort's
label, a sort calculation. A list's own wording (empty-list text, the select button). The speed
settings. Auto-select on a multi-select list and a selection maximum above 100. A filter, a calculated
column or a sort calculation beyond what the record rule set types.

**What step 6 builds toward it.** The reader of case lists and details: one set of columns from the two
details, the order plan, tiles, and a column the case detail alone shows, read exactly as a column
that is not on the list (part 07, section 11). A sort rule's blanks first or last (part 03, section 7).
The record rule reader, under which a slot the checker refuses claims that slot's HELD-NEW entry with
the checker's reason (part 08, sections 8 and 9). Part 08's table of every function in a record slot,
with what each needs built (section 8.1).

**What it decides.**

- The flag column with no list header: HQ's late flag shows none where Nova's interval column shows its
  own (part 07, Departure 1).
- Decided, and no work of this group: the `date()` guard in a generated interval or flag column.
  CommCare HQ's own columns write `date()` under the same blank guard
  (`app_manager/detail_screen.py::TimeAgo`, `::LateFlag`), so an HQ app shows the same invalid cell
  over text that is no date, and Preview marks such a cell as invalid
  (`lib/preview/columnDisplay.ts::formatIntervalForPreview`).
- The ordinary search's results detail: Nova writes one case list for the menu's list and the search
  results detail (`lib/commcare/compiler.ts`), where a read of the Search fields would throw in the
  local list (`expressions-and-data/search-input-results-read-in-the-search-results-detail`, unavailable
  on Android).
- An advanced menu's detail: several address columns and a tile row that mixes two tabs.
- Its platform rows: the `distance` column and sort (unavailable on Web Apps, which never answers
  `here()` in a case list, as step 4's feature `case-list-here` states); the clickable icon (unavailable
  on Android, which prints its raw path); the callout and `fingerprintquery` (ignored and unavailable on
  Web Apps; step 4's value arm `{ kind: "case-list-search-text" }`, printed under the count guard, is
  the model for the read); the `icon_text_grid` template and its slot (different on Android, with
  `menus-and-case-lists/19p-enum-image-whose-keys-are-conditions-contain-any-of-each-a` leaving the
  ambient list); authored alt text on an image map, which takes
  `menus-and-case-lists/enum-mappingitem-alt-text-lang` off the ambient list; the address column
  (different on Web Apps, which hides it in the list and shows plain text on the detail); an image map
  keyed by plain values or by conditions (different on Android, which prints the raw path in an
  `icon_text_grid` tile); a sort's label on a sort-only element or beside an invisible column
  (different on Web Apps, where only a tile's sort menu lists it); the select button's text (different
  on Web Apps, which words only the multi-select button with it, and ignored on Android); an invisible
  or address column in a custom tile (different on Android, which draws it at its stored cell);
  several address columns in an advanced menu's detail (different on Android, where a blank first
  address falls through to the next); the map layers (ignored on Web Apps), the empty-list text and
  the case detail tile (ignored on Android), auto-select on a multi-select list (unavailable on
  Android) and the speed settings (different on Web Apps).

**Exit.** A base per column kind and per tab kind comes in.

## 5. Menus (`menus`)

Menu structure and what a menu offers, beyond what step 6 holds.

**Concepts.** Mirror menus (`Module.mirrorOf`), with the child mirrors HQ keeps in step, excluded forms
and a mirror's own form entry points. A badge on a menu or a form. Computed arguments on an entry point.
The remaining ways a case list offers a form: a follow-up form of the parent case, the action's display
condition, a host or a named form in an advanced menu, a form whose one registration of the type is a
child case, one form offered after an empty search by one list and always by another, and the second
return of the after-empty-search arm. `previous` on a form listed on the first menu, and a link, an
entry point or a Register return built through a first menu that shares one case. A display condition
beyond what the session rule set types, the worker's record in one among it. Nesting across case types:
a child menu of another case type under a parent with no forms, and a parent menu of any other case
type, an extension's host among them (part 04, section 11.2, N14). A form of a child menu reading the
Search fields of a parent menu whose forms read the search.

One item of this group is no entry. *A link to a mirror menu:* a mirror's link frame
(`app_manager/suite_xml/post_process/workflow.py::_get_link_frame`, which sends a link from a mirror
to a form of its source menu through the mirror) and a `form_module_id` that names a mirror, which
arrive with mirror menus (part 02, section 11.9).

**What step 6 builds toward it.** Which screen lists what (`lib/domain/menuScreens.ts`), forms in the
menu above, and the eleven effects of HQ's `put_in_root` as rules (part 02, sections 4 to 9). The
`always` arm of `Module.caseListRegistrationForm`, a discriminated union that admits a new `kind` with
no migration (part 02, section 11). A blank registration label and a blank case list menu item label,
each read as the text CommCare HQ writes for it (part 02, section 11.8; part 07, section 8.6), and the
tools' media target for a case list menu item (part 02, section 12). The menu reader, with after-submit
links and deep links (part 07, sections 8 to 10). A menu of any document type reaches the reader, which
raises a mirror menu as a finding (part 05, section 7; part 06, section 7.1).

**What it decides.** Each row with the reason step 6 gives it (part 02, sections 5.6 and 11.9).

- `previous` on a form listed on the first menu: which frame the form gets depends on every other menu
  above it, so one form's offered set moves with an edit to another menu, and this group brings the
  reconcile that makes that safe.
- A link, an entry point or a Register return built through a first menu that shares one case: Android
  keeps the case on the first menu when a worker steps back, and Preview has no screen that holds a
  chosen case there.
- The follow-up arm and the action's display condition exist only under the flag
  `FOLLOWUP_FORMS_AS_CASE_LIST_FORM`, so an authored condition makes an app need a project-space flag.
- An advanced host or form brings HQ's six rules
  (`app_manager/helpers/validators.py::AdvancedModuleValidator.validate_with_raise`) and a second
  source of return frames.
- A named form whose one registration of the list's type is a child case outside any repeat
  (`app_manager/models/forms.py::Form.get_registration_actions`): its action may carry a selection and
  its return reads that child case's datum (`Form.session_var_for_action`), where Nova's arm names a
  registration form of the list's type, so the wider shape is a second arm.
- One form offered after an empty search by one list and always by another: the form is on no menu, and
  Preview admits it from one launch.
- `post_form_workflow: default` on a host whose forms read the search: Nova's `after-empty-search` arm
  returns to Results showing the new case, and `default` goes on into the host's menu with the new
  case chosen, a second return of that arm
  (`app_manager/suite_xml/post_process/workflow.py::CaseListFormWorkflow._get_stack_frames`).
- Mirror menus: how a mirror and its child mirrors are held and kept in step, and the reader's map from
  the real form ids of the application resource to excluded forms and entry points.
- Whether a parent menu's Search fields reach the forms of its child menu on Web Apps, which holding
  `search-input-read-in-the-forms-of-a-child-menu-of-an-inline-search-menu` turns on (part 08, section
  11). Known: CommCare HQ's build writes a menu's inline query into a form's entry before each datum
  chosen from that menu's list (`app_manager/suite_xml/sections/entries.py::EntriesHelper`,
  `add_remote_query_datums` over the datums `get_datum_meta_module` builds). So a child menu's form
  holds its parent menu's query where its parent selection chooses a case from that menu's list, and
  `add_parent_datums` copies no query, since the parent datums it reads are built before any query is
  added. From step 5 Nova gives such a form no read of its parent's Search fields
  (`caseSearchConfig.formsReadSearch`; `INVALID_SEARCH_REF`, reason `not-forms-read-search`).
- Its platform rows: a badge (different on Android, which hides `0` and shortens text over three
  characters) and a mirror's form entry points.

**Exit.** A base with a mirror menu, a badge and each arm of registering from the case list comes in.

## 6. Case search (`case-search`)

What the Case Search section of CommCare HQ's Case List page writes.

**Concepts.** Typed default filters: a property, an ancestor's property, the owner, the case id, the
project space or a reverse index, each matched by CommCare HQ with the project space's own matching
settings; the search controls a default filter spells (result sort, the related-case property,
related-case inclusion, the case types the request asks for); an owner exclusion only the search
applies. Hidden Search fields in the three shapes Nova's hidden input does not hold. Search field
widgets: a geocoder input with its receiver, a checkbox choice list, allowing a blank value, groups of
fields, a default on a date range, a field name outside Nova's grammar. Result sort, additional case
types, the related-case settings, search on clear, the results instance name, a case search endpoint. A
date compared as the project space's day. A filter the search holds that the list does not, and the
reverse. A date field or a case-attribute field CommCare HQ matches itself. A search title blank in some
languages. A search on a menu that shows its forms above.

**What step 6 builds toward it.** A search with no title as its own arm (part 03, section 6). The
search reader: whether a menu searches and its workflow, fields, settings, and the rows of
`_xpath_query` read as one conjunction, each conjunct held where Nova has a slot that writes it back
(part 07, section 12 and Departure 2). The record rule and CSQL reader behind `readFormSyntax` (part
08, sections 6 and 7), and a list of values, spelled `list(…)` in the record dialect, which every
editor writes (part 08, section 8.3).

**What it decides.**

- *A project space's day.* HQ compares a date with `date_opened`, `closed_on` or `last_modified` as the
  project's day (`case_search/xpath_functions/comparison.py::_create_system_datetime_query` and
  `::adjust_input_date_by_timezone`, with the zone from
  `util/timezones/utils.py::get_timezone_for_domain`, which reads
  `domain/models.py::Domain.default_timezone`). No read an API key gives returns a project space's
  time zone, so Nova's search keeps the worker's day for `today()` and the UTC day for a date coerced
  to a date and time. This group decides how such a comparison is held and how Preview evaluates it
  (part 08, section 7.5). Where it holds a search's `today()` as the project space's day, the declared
  change `search-today-device-day` leaves the register with its rewrite (part 09, section 11.2).
- *Two independent filters.* Where a menu's forms do not read the search, HQ applies the list's filter
  to the list and the search's rows to the search, and Nova's one `caseListConfig.filter` is written to
  both. This group holds a search's own filter and a list's own filter (part 07, Departure 2). Open:
  whether holding the two apart also writes back exactly the two shapes step 6 declares on a menu
  whose forms read the search, a search row that joins the list's filter and a list clause the search
  is sent, so that `search-filter-joined-to-list` and `search-restates-list-filter` leave the register
  with it (part 09, section 11.2).
- *What CommCare HQ matches itself.* A bare date field, a field over `case_id`, `owner_id` or `status`,
  and a plain default filter are matched with the project space's fuzzy and ignore-pattern settings,
  which a clause Nova writes ignores (part 07, Departure 3).
- *A search value that queries device data* (cases, a table, places), which needs a spelling and a card
  for a query inside a search value (part 08, section 8.3), and a search filter the record rule set
  refuses (part 08, section 9.2).
- *The results instance name* (`caseSearchConfig.resultsInstanceName`). Known: CommCare HQ names an
  inline search's results `results:<name>` where the menu sets a name and `results:inline` where it
  sets none (`app_manager/models/case_search.py::CaseSearch.get_instance_name`), and Nova writes and
  reads `results:inline` alone (`lib/commcare/session.ts::INLINE_SEARCH_RESULTS_INSTANCE`). So once a
  name is held, the print of every read of a menu's results depends on that menu's name.
- *A case search endpoint*: the one reference to project data Nova cannot read.
- A list first whose search skips to its results (`auto_launch: false` beside `default_search: true`;
  part 07, Departure 10).
- Its platform rows: the geocoder input (unavailable on Android) and its receiver
  (`case-search/receiver-expression`, ignored on Android), search on clear and field groups (ignored on
  Android), allowing a blank value (ignored on Android), and the hidden fields Android shows.

**Exit.** A base per search workflow with each setting of the section comes in.

## 7. Forms and case management (`forms-and-case-management`)

What an advanced form loads and opens, and the case management rows steps 5 and 6 leave.

**Concepts.** Stored case selections per advanced form (`Form.caseSelections`). From step 5 a menu is
advanced exactly when its kind is held or one of its forms holds an advanced-placed operation, and an
advanced form's loads are derived from its menu's parent-selection chain, with no stored selection; from
step 6 the reader builds the chain from an imported form's loads and raises a form whose loads the chain
does not give (part 07, section 4 and Departure 5). This group takes:

- several selected cases per form, and a second case chosen from another menu's list, of any type,
  beside the chain: its stored shape, how an expression names it (two selections from one list need
  identities `selected-case` cannot tell apart), its Preview list step, and its authoring (a builder
  control, a `selection` target on the case change tools, and its reads);
- a chain that differs between the forms of one menu, which HQ's page allows;
- a load that changes no case and carries a tag Nova does not derive, and a tag or an index name outside
  Nova's grammar;
- auto-selection: `Module.autoSelectSingle` (unavailable on Web Apps where one row matches and the datum
  has `detail-confirm`) and the four auto-select modes step 5 does not emit (it emits only the worker's
  record, as the advanced emission of a worker-record write);
- a case list of the worker's own record;
- computed datums (`Form.computedDatums`): how form logic and a navigation slot read one by identity,
  as they read a chosen case, with its supply among the entry's datum supplies
  (`lib/domain/entryDatumSupplies.ts`) and its id in
  `lib/commcare/formLinkProjection.ts::entryDatumIds`. The advanced form's read of `supply_point_id` is
  held then; step 5's `commtrack-off` reason over the decoded source
  (`lib/commcare/planPrivileges.ts::commtrackReasons`) names that read today;
- a relationship chosen per submission, and a label as a write source;
- shadow forms (`Form.shadowOf`), of a basic or an advanced form, with their selection overrides;
- a child case type under more than one parent (the research's "Also held" list), which waits, as a
  write or a load through an index whose case type the app does not state does, on the relation the
  groups share ("Work that groups share", above).

Beside these: the writer-type joins (decimal, multi-select, text) and a date-and-time question saved
straight to a date property; a preload from any other index path, a preload held at the end of the load,
and a preload into a question that holds no default; saving only a changed answer beyond a follow-up
form's own update; a write or a load through an index whose case type the app does not state; a write to
`location_id` or `hq_user_id`; a case property name with a letter outside ASCII; a write through an
index named `user`; a submit label; an advanced menu Nova would write as a basic one; a record slot that
reads a session value the dialect cannot spell.

**What step 6 builds toward it.** The reader of basic and advanced forms, of placements and of the
session values an entry holds (`publishedCaseBlocks` extended, `hqEntryFacts`; part 07, sections 3 to
7). An advanced load's preload read as the question's default wherever nothing later in the load reads
the question, and an update through the date-and-time join, both held (part 07, sections 3.7 and 14).
Hyphens in a case write's property and the keys `category` and `state` (part 04, section 6). A fuzz
family in the lane that draws advanced menus and step 5's link shapes (part 14, section 11.2).

**What it decides.** Each shape above, and:

- a third advanced trigger becomes reachable, a form selecting a case beyond its menu's chain, which
  `lib/commcare/moduleKind.ts::emittedModuleKind` then reads, and a registration form that loads a case
  becomes possible, so the sync-on-form-entry predicate (`formEntrySyncReasons`) then reads the
  selection;
- a preload's place in the load. Known: HQ's build appends a load's preload setvalues after every
  setvalue the form holds (`app_manager/xform.py::XForm._create_casexml_advanced`), Nova writes a
  writer's starting value as its default, and the reader's rule is structural (`laterLoadReaders`; part
  07, Departure 9), so it may raise the finding
  (`forms-and-case-writes/loadupdateaction-preload-read-later-in-the-load`) for a form whose later
  reader happens to see the same value. A basic form's stored `case_preload` is appended the same way
  (`app_manager/xform.py::XForm._create_casexml`), and CommCare HQ's basic Case Management page draws
  no load section and keeps a stored one through its save, so step 6 holds its entry
  (`forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held`) not-yet
  with this group as its owner, and never as something to change in CommCare HQ (part 07, section 14);
- its platform rows: a submit label (`forms-and-case-writes/submit-label-non-default`, ignored on
  Android) and `Module.autoSelectSingle`
  (`menus-and-case-lists/auto-select-case-on-an-advanced-module`, unavailable on Web Apps where one row
  matches and the datum has `detail-confirm`).

**Exit.** A base with an advanced menu whose forms hold several selections, an auto-selected case, a
computed datum and a shadow form comes in.

## 8. What a form holds (`xform`)

The rest of what CommCare HQ's form builder writes into a form.

**Concepts.** New kinds of question: an acknowledge question (it holds an answer, which a label does
not, so it is a kind as signature is; part 03, section 2.4), face capture, and an Android app callout,
with a reference to a callout from another input. An image's maximum size. A repeat's add captions. A
question's data under another group than its control (`Field.dataParent`). A question locked in
CommCare HQ (`Field.lockedInHq`). A Hidden Value's default beside its calculate, its own bind type, and
its data node's namespace. Choices from a query: a sort column, a filter beyond what the record rule
set types, and a source other than Nova's case-choices shape. A choice value holding both quote marks.
The form's pragma settings held as text (auto-submit, the saved-form descriptor). Logic and text on
kinds that hold none today: required and a hint on a label; a validation condition and its message on a
location question, a capture question or a label; a default, help and help media on a capture question
or a label. A Save to Case question at an authored position, and the Save to Case shapes Nova's block
does not have (a case type as an expression, an authored case id, a block that closes beside another
action, a condition on the owner, a link name outside Nova's grammar). CommCare Connect: a work area
update and a work area id expression, blocks beyond one of each kind, an app that is both a learn app
and a deliver app. A repeat over a model by the load-time rule. A data root not named `data`, and a
question named `case`, `registration` or `script`. Form logic beyond what the form rule set types:
comparisons Core coerces, `*` steps, reads of the blocks HQ's build adds.

**What step 6 builds toward it.** The form reader: structure, itext, prose, generated nodes folded back,
Connect blocks (part 06, sections 8 to 15). Save to Case blocks held in Nova's own shape, with the
boundary stated as four mechanical tests (part 07, section 5 and Departure 4). The form-logic reader
and the mapping from a checker refusal to its entry, which this group narrows as it widens a rule set
(part 08, section 9.2). A calculated value in prose and a form whose text formatting is off (part 03,
sections 4 and 8). The seven slots a kind does not hold, each split from the row that holds it
elsewhere (part 04, section 2.2).

**What it decides.**

- The Hidden Value's two sources. The contract "a `hidden` field carries exactly one value source"
  retires: `HIDDEN_VALUE_BOTH_SOURCES`, the tool-schema gate, `editField`'s clearing of the held slot
  and the builder's one Value control each change ("Contracts", below).
- The three new kinds (the acknowledge question, face capture and the Android app callout), which are
  this group's entries and are built under part 03's display rules (part 01, Appendix A.1; part 03,
  section 2.4). The reference to a callout from another input
  (`questions/intent-id-on-any-input-other-than-an-intent-typed-one-where-id`) is this group's entry
  too, though its subject, `question-appearance`, is otherwise `question-display`'s: it cannot be built
  without the callout kind (part 01, section 2.3). This group builds the reference with the kind, so
  `question-display` waits on this group for nothing.
- A new slot on up to seven field kinds for each of validation, a default, help and a hint, each with
  its editor, its Preview check and its emission (part 04, section 2.2).
- Connect blocks beyond one of each kind: `lib/domain/connectIds.ts::connectBlocks` reads one block of
  each kind per form and every Connect surface rests on it; and one `connectType` for an app.
- Model iteration by the research's load-time rule ("Load-time values") in place of step 5's structural
  rule (part 06, section 10.4).
- Its platform rows: the acknowledge question (different on Web Apps, which answers one itself, so a
  required one never blocks), face capture (a plain image upload on Web Apps), the Android app callout
  (unavailable on Web Apps as the date-and-time question is: the client holds "Not Supported by Web
  Entry" as the answer, so the question is refused where Web Apps is declared), the reference to a
  callout from another input (ignored on Web Apps), an image's maximum size (ignored on Web Apps), a
  Hidden Value's default beside its calculate
  (`questions/hidden-value-with-both-calculate-and-a-default-by-any-expression`, different on Web Apps,
  where the default inside a repeat row never reaches a submission), and the two pragma settings (one
  runs on each platform).

**Exit.** A base per question kind of the form builder's palette comes in, with a Save to Case question
at an authored position.

## Contracts

The research's contracts table gives step 7 these rows, each now with its group.

| Contract row | Group |
|---|---|
| A Hidden Value may keep its default beside its calculate (`lib/domain/CLAUDE.md`, `components/builder/CLAUDE.md`, `lib/commcare/CLAUDE.md`) | `xform` |
| The case detail tile is held (`docs/architecture/contracts.md`, "Long-detail tiles are out of scope") | `case-list-and-detail` |
| `case_sharing` and every other held setting as a key-level overlay | `settings-nova-comes-to-own` |

The table's two other rows that name step 7 leave it nothing. A form's type as its own case's
lifecycle is whole since step 5 (`lib/domain/CLAUDE.md`, "Four form types"), and stored case selections
change nothing of it. The document's external identities need no further slot: language wire codes are
in the document since step 2, and from step 6 a menu's and a form's HQ ids, a form's `xmlns` and a
media file's path are ledger rows of a deployment and no document slot (part 10, "Contracts and docs
these changes make false").

## Not planned

Five features are not planned, in this outline or in step 6. Each is named here once, with what it
would take. None is owed: no group owns one, no manifest entry or circumstance names one, and nothing
in step 6 or in a group above waits on one.

- **Keeping both sides' changes by merging them.** Where Nova holds unpublished changes and the app
  also changed in CommCare HQ, step 6 shows both lists and the person chooses one side whole (part 15,
  section 6); a merge would take a rule for every pair of mutation kinds that can touch one slot, and
  a view that asks about each conflict (part 15, Departure 1).
- **Using CommCare HQ's rows for a table Nova manages.** Step 6's lookup stop has one answer, to
  publish over the change, and the table's page gives "Let CommCare HQ manage it again" (part 11,
  section 9); a second answer at the stop would take a replacement that carries CommCare HQ's columns
  with its rows and names every app that reads the table, since
  `lib/lookup/service.ts::replaceLookupRows` replaces rows under the table's current columns (part 11,
  Departure 7).
- **Taking an organization over.** Places that came from CommCare HQ are a copy managed there, with no
  "Manage in Nova" (part 11, section 11.4); taking them over would take deciding what a merge of
  Nova's places with CommCare HQ's is, which nothing has defined.
- **Restoring an app to an earlier revision.** `app_changes` keeps every change and no Nova surface
  restores one; a restore, which is what would make a discarded change recoverable, would take
  deciding what the deployment's ledger becomes, what saved case rows do and what held placements do
  (part 15, section 6.4).
- **A second project space for one app.** Publishing to another project space makes a new app there,
  and a copy the team already keeps there stays as it is (part 13, sections 8.8 and 11.2); updating
  that copy would take an adoption for a deployment that is not the app's birth, with the copy read
  and compared with the Nova document before anything is written, its ids recorded for that
  deployment (part 10, sections 3 and 4), its claim taken (part 10, section 5) and its baseline
  stored. Known at the pin: a copy made by CommCare HQ's own copy keeps each menu's `unique_id` and
  each form's `xmlns`, gives every form a new id, and holds its own copy of each table the app reads,
  under another tag where that tag was taken (`app_manager/models/applications.py::import_app_from_id`,
  `app_manager/util.py::update_form_unique_ids`,
  `app_manager/lookup_table_import.py::copy_lookup_tables` and `::_destination_tag`).
