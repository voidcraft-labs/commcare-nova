# HQ round trip: the plans

These plans carry out the HQ round-trip research
([`docs/research/2026-09-26-hq-round-trip/`](../../research/2026-09-26-hq-round-trip/README.md)):
The goal is to bring in any app CommCare HQ's editors can build, hold it as
a typed Nova document, edit it and publish it back. The research gives seven steps. Steps 1–6 shipped.
Step 6 used additive migrations while the previous revision served. In the final step each feature group
is a unit for the cutover rule. Groups that change a stored shape incompatibly use one direct maintenance
cutover for that shape. Where a plan cites a defect, a section or a contract row, it
means the research's "Defects in Nova today", its section of that name, or its
"Contracts this work changes" table.

| Step | Plan | Depth |
|---|---|---|
| 1 | The manifest and the harness | done: [`proof/README.md`](../../../proof/README.md) |
| 2 | Emission and publish fixes | done: [`lib/commcare/CLAUDE.md`](../../../lib/commcare/CLAUDE.md), [`lib/deployment/CLAUDE.md`](../../../lib/deployment/CLAUDE.md), [`proof/README.md`](../../../proof/README.md) |
| 3 | Expressions | done: [`lib/domain/CLAUDE.md`](../../../lib/domain/CLAUDE.md), [`lib/domain/expression/CLAUDE.md`](../../../lib/domain/expression/CLAUDE.md), [`lib/commcare/CLAUDE.md`](../../../lib/commcare/CLAUDE.md), [`proof/README.md`](../../../proof/README.md) |
| 4 | Platforms | done: ["Step 4 is done"](#step-4-is-done) |
| 5 | Case writes, forms and navigation | done: ["Step 5 is done"](#step-5-is-done) |
| 6 | Bringing an app in from CommCare HQ | done: ["Step 6 is done"](#step-6-is-done) |
| 7 | [The rest of the model](7-rest-of-model.md) | implementation plan for all eight remaining groups, with shared dependencies, proof and cutover |

## Step 1 is done

Step 1 built the evidence every later step stands on, and its plan has left
this directory. What endures lives where it is read:

- **The surface manifest**, `lib/commcare/surface/`: the generated surface of
  everything HQ, Core and Android accept in an app, and the authored entries
  that give each inventory row and each gate its disposition
  (`lib/commcare/CLAUDE.md`, "The surface manifest"). The project-space check
  reads its flags' identities from the gate entries, and the weekly pin pull
  request (`.github/workflows/upstream-pins.yml`) brings upstream changes in
  as one reviewed pull request.
- **The proof lane**, `proof/`: CommCare's own code reading Nova's exports at
  the pinned commits, over a reproducible corpus: HQ's import, build, case
  processing, editors, receiver, restore, search views and Connect repeater;
  CommCare Core's runtime; Formplayer's own application; HQ's Web Apps client
  in Chromium; CommCare Connect's own server; and commcare-android's own
  code, beside HQ's live unit. Every pull request runs it without the served
  readers, each scheduled night runs every reader over what changed, and each week runs
  it whole (`proof/README.md`, "The lane in CI").
  `proof/README.md` holds what it proves (the bar, the intent, manifest and
  sensitivity checks, proofs 1 to 6, each judged over every reader), the
  corpus, the registers, the spelling rules, the defect rows of the plan's
  work item 12, and step 1's decisions; `proof/CLAUDE.md` holds the rules
  that bind changes to it; `docs/architecture/contracts.md` the delivery
  contract it enforces.
- **The known-defect register**, `proof/known-defects.json`: one entry per
  symptom the lane reproduces, each with its document and its retained
  control, each resting on a record a real reader made (an entry of a
  reader names it in its artifact: `formplayer@`, `webapps@`, `connect@`,
  `android@`). Its `defect` is the research's number or one of the
  harness's own findings, numbered from 31 in
  [`harness-findings.md`](../../research/2026-09-26-hq-round-trip/harness-findings.md),
  which also records the research claims the harness corrected. It holds no
  entry for an equivalence: two spellings every reader reads alike are a
  spelling rule, proven by tests that run each of those readers on both.

Every row of step 1's defect table now has register entries that reproduce on
their controls or a test that runs HQ's own page or view over a Nova export
(`proof/views`), with one exception that a test settles the other way:
"12, same-type child", whose input no Nova document holds
(`proof/targeted/__tests__/unproducedInputs.test.ts`). The clause step 1 was
once done but for, defect 3's unknown-question warning, shows on
`targeted-save-to-case-read`; and "20, CommTrack", which step 1 had left out
as an input Nova cannot produce, is a row again, since Nova's gate admits the
read it needs (finding 68). `proof/README.md` ("What the lane does not
observe") holds what is outside the lane, a behavior that depends on nothing
in Nova's app; everything that depends on Nova's export is observed.

Step 2 settled the two rows this paragraph names. Defect 3's unknown-question
warning no longer shows on `targeted-save-to-case-read`: its two entries are in
`proof/fixed-defects.json`, on the control of that name. And Nova's gate
refuses the read "20, CommTrack" needs (finding 68).

## Step 2 is done

Step 2 fixed the emission and publish defects the harness showed, so the
known-defect register held no entry for defects 1 to 10 or 12 to 16 and
none for a finding of the harness but finding 56, which step 3 fixed. It also made a publish an
update of an app Nova has read. Its plan has left this directory. What
endures lives where it is read:

- **Identity that holds across publishes**, `lib/commcare/wireIdentity.ts`
  and the document's `localization.wireCodes`: a menu's and a form's HQ id
  and a form's `xmlns` are derived from the Nova entity's UUID, and a
  language's CommCare code is stored when the language is added
  (`lib/commcare/CLAUDE.md`, `lib/domain/CLAUDE.md`). The ids a project
  space held before ids were derived are in `app_deployment_identities`
  (`lib/deployment/CLAUDE.md`, "Identities").
- **The publish sequence and its ledger**, `lib/deployment/`: the empty app
  a first publish makes before any Project data, the reads of the app's
  source, the stop on a change made in CommCare HQ since Nova's last push,
  the CommCare version floor, and the confirmations a publish asks a person
  for (`lib/deployment/CLAUDE.md`; the tables in `lib/db/CLAUDE.md`;
  `docs/architecture/contracts.md` for the drift rule).
- **Emission HQ's editors keep**, `lib/commcare/`: generated nodes named by
  one allocator, case operations as Save to Case blocks the form builder
  writes back unchanged, `profile`, `translations` and `add_ons` projected
  over what the project space holds, and one order plan for a case list
  (`lib/commcare/CLAUDE.md`; `docs/architecture/complex-apps.md` for the
  binding CommCare facts). The two HQ facts that bind every later step are
  in `docs/architecture/contracts.md`, "Nova is not CommCare HQ.".
- **The fixed-defect register**, `proof/fixed-defects.json`: every entry
  step 2 fixed, each still showing on its retained control
  (`proof/README.md`, "Fixed defects"). `proof/known-defects.json` holds
  only what a later step owns, and
  `proof/checks/registers.py::OPEN_DEFECTS` names the step for each.
  `proof/walk-stops.json` holds each place a reader's walk still ends short
  (`proof/README.md`, "Walk stops"), and `proof/hq-reads/` holds the
  answers of HQ the drift comparison is proven over.
- **What planning step 2 found**,
  [`harness-findings.md`](../../research/2026-09-26-hq-round-trip/harness-findings.md),
  "Found while planning step 2" and "What HQ does itself".
- **The cutover's trace.** The cutover ran once, before the merge, and its
  scripts, its Job and its runbook are removed. What it left is each app's
  `fold-baseline:hq-round-trip-emission` row (`lib/db/CLAUDE.md`), each
  app's notice (`lib/notices/`) and its evidence archive
  (`docs/architecture/deployment.md`, "Historical repairs").
  `docs/architecture/contracts.md`, "Direct maintenance cutover", holds the
  rules it followed.

## Step 3 is done

Step 3 made every expression a typed tree that holds its references by
identity, and its plan has left this directory. What endures lives where it
is read:

- **The expression union**, `lib/domain/expression/`: one stored
  `Expression` for form logic, record slots and CSQL, each leaf a typed term
  and each reference an identity (a field by UUID with the author's spelling
  kept, a case property as `(caseType, property)`, a session datum, a lookup
  table or column, a location level or property, a worker property, a search
  input, a static option, a translation unit), printed in one canonical
  spelling (`lib/domain/CLAUDE.md`).
- **One checker**, `lib/domain/expression/typeChecker.ts::checkExpression`,
  with a rule set for record slots and one for form logic, behind the commit
  gate (`lib/commcare/CLAUDE.md`).
- **One wire tree and serializer**, `lib/commcare/xpath/wire/`: `toWire` and
  `serializeWire` for the XForm, its Vellum shadow, the suite, HQ's JSON and
  Preview; a comparison of two dates and times lowered to instants
  (`instant.ts`); instance declarations derived from what the text reads;
  CSQL built as a tree (`lib/commcare/csql/`) (`lib/commcare/CLAUDE.md`).
- **Preview and the case store**: Preview evaluates what the device
  evaluates (`lib/preview/CLAUDE.md`), and Postgres compiles the same union
  (`lib/case-store/sql/CLAUDE.md`).
- **The fixed-defect register**: finding 56's and finding 75's entries and
  defect 25's one blank-answer manifest entry, each still showing on its
  retained control (defect 25's other entries remain live), finding 75's walk
  stop held on its control in `proof/walk-stops.json`, and the native
  families `expression`, run in every device zone, and `csql`
  (`proof/README.md`, "Native proofs").
- **What planning step 3 found**,
  [`harness-findings.md`](../../research/2026-09-26-hq-round-trip/harness-findings.md),
  "Found while planning step 3".
- **What step 3 left to later steps** is recorded under steps
  [4](#step-4-is-done), [5](#step-5-is-done) and [6](#step-6-is-done).
  The remaining expression features belong to [step 7](7-rest-of-model.md).
- **The cutover's trace.** The cutover ran once, before the merge, and its
  scripts, its Job and its runbook are removed. What it left is each app's
  `fold-baseline:hq-round-trip-expressions` row (`lib/db/CLAUDE.md`), each
  app's notice (`lib/notices/`) and its evidence archive
  (`docs/architecture/deployment.md`, "Historical repairs").

Finding 74 was held by two walk stops, on `targeted-datetime-ordering` and
`fuzz-xform-20260930-0`, and step 4 closed it. Step 4 declares both documents
Android only, so the stop on the first is held on its retained control in
`proof/walk-stops.json` and the second is removed (["Step 4 is
done"](#step-4-is-done)). Step 5 fixed the register's other entries, defects
21, 23 to 28 and 30 (["Step 5 is done"](#step-5-is-done)).

## Step 4 is done

Step 4 made where an app runs a fact of the app, and its plan has left this
directory. Every app declares Web Apps, Android or both
(`appSettings.runsOnlyOn`), and from that one declaration Nova refuses a
feature or a media file a declared platform cannot run, offers each choice
only where it runs, states each difference where the author works, publishes
the declaration to CommCare HQ, and plays each declared platform in Preview.
It fixed the second half of defect 11 (media by platform), defect 18 (the
date-and-time question in Web Apps), defect 19 (features that behave
differently by platform, silently), defect 20's sync on form entry and
finding 74. What endures lives where it is read:

- **The declaration and the platform table**, `lib/domain/platforms.ts` and
  its detectors `lib/domain/platformUses.ts`: each feature one platform
  cannot run, with its readings and copy, and the ambient differences no
  author chooses (`lib/domain/CLAUDE.md`). The table stands for the surface
  manifest's per-platform readings, held to them by a binding test, and the
  gate refuses a use a declared platform cannot run
  (`PLATFORM_FEATURE_UNAVAILABLE`, and the checker's `platform-unavailable`
  reason in an expression slot) (`lib/commcare/CLAUDE.md`,
  `lib/domain/expression/CLAUDE.md`). `docs/architecture/complex-apps.md`,
  "Where an app runs", records the binding CommCare facts, and
  `docs/architecture/contracts.md` the emission contract.
- **The date-and-time split**, `lib/doc/datetimeSplit.ts`, and the planner
  of the declaration a document's content allows,
  `lib/doc/platformDeclaration.ts` (`lib/doc/CLAUDE.md`).
- **Media by platform**, `lib/media/`: the variant each ready file records
  (`media_assets.media_format`) and a reference accepted only where every
  declared platform plays it (`lib/media/CLAUDE.md`, "Accepted formats and
  where they play"; `docs/architecture/complex-apps.md`, "Media").
- **Publish**, `lib/deployment/`: the declaration written as HQ's Web App
  setting, the `web-apps` plan feature, the Web Apps question, the
  first-publish stop, the `form-entry-sync-off` confirmation, and no `.ccz`
  for an app that does not declare Android (`lib/deployment/CLAUDE.md`,
  `lib/export/CLAUDE.md`).
- **Preview per platform**, `lib/preview/`: one declared platform at a time,
  one rule table, and a cell table that holds every differing cell to its
  evidence (`lib/preview/CLAUDE.md`, "Platforms").
- **Authoring**: the builder's platform section, offering by declaration and
  the note row (`components/builder/CLAUDE.md`); `updateApp`'s
  `runs_only_on`, the guide's platform sentences and the pre-checks
  (`lib/agent/CLAUDE.md`, `lib/agent/authoring/CLAUDE.md`); the public page
  "Where workers use your app" (`content/docs/where-workers-use-your-app.mdx`).
- **The proof lane**: each reader reads a document only on a platform it
  declares (`proof/CLAUDE.md`; `proof/README.md`, "Platforms"); defect 20's
  entries are in `proof/fixed-defects.json`, each still showing on its
  retained control (`proof/README.md`, "Fixed defects"); finding 74's stop is
  held on the control of `targeted-datetime-ordering` in
  `proof/walk-stops.json` (`proof/README.md`, "Walk stops").
- **What planning step 4 found**,
  [`harness-findings.md`](../../research/2026-09-26-hq-round-trip/harness-findings.md),
  "Found while planning step 4".
- **What step 4 left to later steps**, each with its reason: CommTrack's
  confirmation and defect 21, which step 5 took (["Step 5 is
  done"](#step-5-is-done));
  step 6 reads a split question back as three questions, a guarded read as
  the bare read, and a `current()` read with its spelling. The reader contract
  records these equivalences. The remaining features include a child module of a search-first
  parent, `fingerprintquery` and an ordinary search's results detail, as set out in
  [`7-rest-of-model.md`](7-rest-of-model.md).
- **The baseline step 4's plan was written against**: `main` at `e9e6cd93`,
  which is step 3's stack (#773 to #791) merged and its cutover run, then
  #798, #799 and #800, at the CommCare pins named under "Rules every plan
  follows".
- **The cutover's trace.** The cutover ran once, before the merge, and its
  scripts, its Job and its runbook are removed; they stay in `main`'s history
  on the commit before the one that removed them, which is where the
  validation migration's refusal sends a database that predates the cutover
  and never ran it. What it left is the five
  ledgered migrations of step 4 with `mediaFormat.postgres.test.ts`
  (`lib/case-store/migrations/`); `lib/doc/platformDeclaration.ts`, which
  the fuzz mapping and step 6's proposed declaration read; each changed app's
  `blueprint-migration` row by `system:hq-round-trip-platforms`
  (`lib/db/CLAUDE.md`); each affected app's notice, cutover
  `hq-round-trip-platforms`, whose lead, four reasons
  (`platforms-declared`, `datetime-question-split`,
  `media-not-played-removed` and `next-publish-asks-web-apps`),
  `PLATFORM_CAUSE_WORDS` and the `form-entry-sync-off` sentence of
  `next-publish-asks-more` stay so stored rows render (`lib/notices/`); the
  two public-docs sentences that name where an app runs as something Nova
  changed (`content/docs/publishing.mdx`, "Updates to review", and the
  `get_app` row of `content/docs/mcp/tools.mdx`); and its content-free
  evidence archive under the prefix `hq-round-trip-platforms/`, reports and
  IAM policy reads only, never deleted from
  (`docs/architecture/deployment.md`, "Historical repairs").

## Step 5 is done

Step 5 made a form's case writes one concept with a place in CommCare HQ that
a publish keeps, and its plan has left this directory. A form's case writes
are its case operations, the form's own case among them, and a field's "Saves
to" is that field's view of them; each case change, query repeat and advanced
menu keeps the place in CommCare HQ the publish that first carries it
records, and an edit that moves one says so on every editor before it saves.
It fixed defects 21 to 30 (the search workflow; case writes as one concept;
attachment mode; extension child cases; query repeat placement; form links;
field lists; explicit preloads and plain labels; the menu concepts;
whole-number counts), defect 12's links between cases of the same type at
publish, and defect 20's CommTrack half. What endures lives where it is read:

- **Case writes and placements**, `lib/domain` and `lib/commcare`: the own
  arm, `via`, `onlyIfChanged`, the worker's record, `capture-link`, open and
  close conditions (`lib/domain/CLAUDE.md`);
  `lib/commcare/placement.ts::planPlacements` and
  `casePlacementPlan.ts::planFormCaseWire` (`lib/commcare/CLAUDE.md`,
  "Authored case-operation emission"); `docs/architecture/complex-apps.md`,
  "Field id, case writes, and app-wide property rename".
- **Held placements and identity moves**, `lib/doc`: `holdPlacements`,
  `withIdentityMoves` and the per-subject planners (`lib/doc/CLAUDE.md`), the
  kernel rule `lib/db/placementAuthority.ts::placementChangeRefusal`
  (`lib/db/CLAUDE.md`), and the contract in `docs/architecture/contracts.md`,
  "HQ deployment safety".
- **Publish**, `lib/deployment`: the `publish-placement` app change, the
  placement offers, `commtrack-off`, `same-type-child-links` and
  `lib/commcare/hq/publishedCaseBlocks.ts` (`lib/deployment/CLAUDE.md`,
  "Placements").
- **Advanced modules and extension child cases** (`lib/commcare/CLAUDE.md`,
  "Advanced modules"; `docs/architecture/complex-apps.md`, "Advanced
  modules").
- **Questions**: query repeat placements, whole-number counts,
  `group.fieldList` and `plainLabel` (`lib/commcare/CLAUDE.md`, "Repeat
  modes" and "Markdown itext").
- **Menus and search**: `caseSearchConfig.workflow` and `formsReadSearch`,
  `Module.caseListMenuItem` and `Module.caseListRegistrationForm`, and a
  claim as a case row (`lib/domain/CLAUDE.md`, `lib/case-store/CLAUDE.md`,
  `docs/architecture/complex-apps.md`, "The search workflow").
- **Form links**: destinations in the author's order, `Form.otherwise`,
  `this-form` and the held-case guard (`lib/commcare/CLAUDE.md`,
  "After-submit links (`form_links`)"; `docs/architecture/complex-apps.md`,
  "After-submit links").
- **The proof lane**: every one of the register's entries in
  `proof/fixed-defects.json`, each still showing on its retained control,
  `OPEN_DEFECTS` empty; the migration witnesses, their retained A
  (`proof/migrations/`), HQ's reads of it
  (`proof/hq-reads/targeted-migration-*`) and the identity moves scoped to
  them (`proof/README.md`, "Identity moves").
- **What planning step 5 found**,
  [`harness-findings.md`](../../research/2026-09-26-hq-round-trip/harness-findings.md),
  "Found while planning step 5".
- **What step 5 left to later steps** includes reading case-write placements,
  preloads and form links back from HQ ([step 6](#step-6-is-done)).
  [Step 7](7-rest-of-model.md) covers additional case and navigation features.
- **The baseline step 5's plan was written against**: `main` at `2f985ed6`,
  which is step 4's stack (#809 to #825) merged and its cutover run, at the
  CommCare pins named under "Rules every plan follows".
- **The cutover's trace.** The cutover ran once, before the merge, and its
  scripts, its Job and its runbook are removed; they stay in `main`'s history
  on the commit before the one that removed them. What it left is the three
  ledgered migrations of step 5 with `caseWritesLedger.postgres.test.ts`
  (`lib/case-store/migrations/`); each app's
  `fold-baseline:hq-round-trip-case-writes` row, the sixth fold identity
  (`lib/db/CLAUDE.md`); the pure planners the fuzz mapping and step 6 read
  (`lib/doc/fieldWriteOperations.ts`, `explicitPreloads.ts`,
  `repeatCountWraps.ts`, `groupFieldLists.ts`, `searchWorkflowPlan.ts`); the
  form-link map `lib/doc/formLinkSemanticsMap.ts`, with the test that holds
  every migrated app's links to their behavior before; each affected app's
  notice, cutover `hq-round-trip-case-writes`, whose lead and reasons stay so
  stored rows render (`lib/notices/`); the two public-docs sentences that
  name where workers go after a form as something Nova changed
  (`content/docs/publishing.mdx`, "Updates to review", and the `get_app` row
  of `content/docs/mcp/tools.mdx`); and its content-free evidence archive
  under the prefix `hq-round-trip-case-writes/`, reports and IAM policy reads
  only, never deleted from (`docs/architecture/deployment.md`, "Historical
  repairs").

The trace's reason list is the one the cutover registered, `form-link-removed`
among them: the cutover keeps that removal for a link to an unoffered submenu
whose parent is off the menu, which an author could still make until the
cutover ran, so the reason ships whether or not an app's notice names it,
and stays so stored rows render.

The `../nova-plugin` change rides the stack:
[voidcraft-labs/nova-plugin#74](https://github.com/voidcraft-labs/nova-plugin/pull/74)
takes the plugin to `2.4.0`, and it merges once the deploy carrying step 5 is
live.

## Step 6 is done

Nova can bring a whole app in from CommCare HQ, let its team edit it in the
builder or through chat or MCP, and publish it back to the same HQ app.
The review names what the first publish changes. When a source feature keeps
the app from coming in, Nova lists what it found and where, with a next step
for each finding. A later change in HQ can come back into the same Nova app.

### Reading and publishing

- The [repository map](../../../CLAUDE.md) describes how a read from HQ becomes
  a Nova document and how its editors share one deployment lifecycle.
- The [architecture reference](../../architecture/complex-apps.md#bringing-an-app-in-from-commcare-hq)
  gives the admission conditions and the CommCare behavior behind them.
- The [CommCare boundary](../../../lib/commcare/CLAUDE.md) brackets a read of
  an HQ app with its save counter, aligns forms with their stored ids, and
  classifies source values against the surface manifest.
- The [reader](../../../lib/commcare/reader/CLAUDE.md) accounts for the source
  and checks its proposed reading against the production emitter. It covers
  forms, case operations, menus, lists, search and expressions.
- The [deployment contract](../../../lib/deployment/CLAUDE.md) defines the
  review digest, acceptance under each offered platform, and the closed list
  of first-publish changes. It keeps an adopted app's identities and media
  paths for its own project space. One live Nova app can publish to an HQ app.
- The [architecture contracts](../../architecture/contracts.md) define the
  `hq-adoption` birth and the changes a publish may write to an adopted
  deployment. Project media files can already exist when the birth commits.
- The [database contract](../../../lib/db/CLAUDE.md) records the app, its
  source baseline, target claim and identities in the genesis transaction.
  A later bring-in records what Nova accepted from HQ against a Nova revision.
- The [document contract](../../../lib/doc/CLAUDE.md) describes the mutations
  that bring in the difference between two HQ readings. When both sides
  changed, the review names what taking HQ's version would remove.
- The [multiplayer contract](../../../lib/collab/CLAUDE.md) explains how open
  builders reload after an `hq-changes` commit and show who brought it in.
- The [export contract](../../../lib/export/CLAUDE.md) defines the identity,
  media and managed data that each destination receives.
- The [lookup contract](../../../lib/lookup/CLAUDE.md) covers a table copied
  from HQ, who can change it, and what happens when its management changes.
- The [organization contract](../../../lib/organization/CLAUDE.md) describes
  refreshing places by their HQ identities and retaining places that saved
  data or app configuration still uses.
- The [media contract](../../../lib/media/CLAUDE.md) covers validating files
  read from HQ and publishing them to the Project library.
- The [case-store contract](../../../lib/case-store/CLAUDE.md) and its
  [migration registry](../../../lib/case-store/migrations/index.ts) hold the
  four migrations for lookup names, the deployment ledger, the app-change
  kind and managed Project data.
- The [deployment procedure](../../architecture/deployment.md) describes how
  the migration Job checks the incoming rules over saved apps.

### Authoring and the worker experience

- The [domain](../../../lib/domain/CLAUDE.md) models forms shown in the menu
  above, case-list registration, phone numbers, calculated values in text,
  columns shown only in details, and the names an app may use.
- The [expression vocabulary](../../../lib/domain/expression/CLAUDE.md)
  includes lists of values in record expressions.
- The [XPath parser](../../../lib/commcare/xpath/CLAUDE.md) resolves names
  read from an HQ expression to identities.
- The [wire printer](../../../lib/commcare/xpath/wire/CLAUDE.md) supplies the
  spelling the reader compares against.
- The [localization contract](../../architecture/multilingual-localization.md)
  covers multilingual form text and the language codes carried back to HQ.
- The [Preview contract](../../../lib/preview/CLAUDE.md) covers menu and search
  navigation, formatted values in text, and saved dates and times.
- The [case-store SQL contract](../../../lib/case-store/sql/CLAUDE.md) defines
  comparisons for saved record expressions.
- The [App Test contract](../../../lib/preview/app-tests/CLAUDE.md) records the
  runtime version for saved journeys.
- The [builder](../../../components/builder/CLAUDE.md) owns the review on
  `/build/new`, activation of the new app, and the check for HQ changes when
  an app opens.
- The [routing contract](../../../lib/routing/CLAUDE.md) defines how a shared
  address reopens an HQ review.
- The [component contract](../../../components/CLAUDE.md) describes the
  chooser and its radio rows.
- The [design system](../../../design/readme.md) describes how the review
  explains a limit and shows what a person can do next.
- The [agent contract](../../../lib/agent/CLAUDE.md) versions the tool
  catalog per deployed build.
- The [authoring guide](../../../lib/agent/authoring/CLAUDE.md) describes
  how the Solutions Architect edits an app a person brought in.

### User guides

- [Bringing in an app from CommCare HQ](../../../content/docs/bringing-in-from-commcare-hq.mdx)
  walks through choosing the app, reviewing its reading and opening it in Nova.
- [Publishing](../../../content/docs/publishing.mdx) covers the next publish,
  changes made in HQ and ending a deployment.
- [Project-space compatibility](../../../content/docs/project-space-compatibility.mdx)
  explains the checks before publishing.
- [Where workers use your app](../../../content/docs/where-workers-use-your-app.mdx)
  covers the Web Apps and Android choices a review offers.
- [Project data](../../../content/docs/project-data.mdx) explains refreshing
  the copies of lookup tables HQ manages and taking over a table.
- [Organization](../../../content/docs/organization.mdx) covers refreshing
  places from an HQ project space.
- [Building with Nova](../../../content/docs/building-with-nova.mdx) covers
  questions and calculated values in wording.
- The [case workspace](../../../content/docs/case-workspace.mdx) covers
  registration from a case list, sorting and detail columns.
- [Nested menus](../../../content/docs/nested-menus.mdx) shows how to put
  forms in the menu above.
- [Form links](../../../content/docs/form-links.mdx) explains the destinations
  a worker can reach after submitting a form.
- [Deep links](../../../content/docs/deep-links.mdx) covers choosing a shared
  destination, including a form shown in another menu.
- [Display conditions](../../../content/docs/display-conditions.mdx) explains
  where a menu or form's condition is checked.
- [Case changes](../../../content/docs/case-changes.mdx) explains case and
  property names.
- [CommCare Connect](../../../content/docs/commcare-connect.mdx) covers block
  names and descriptions.
- [Languages](../../../content/docs/languages.mdx) explains reviewing
  translated content and references.
- The [MCP tool catalog](../../../content/docs/mcp/tools.mdx) documents the HQ
  reviews and their answers.
- [Connecting](../../../content/docs/mcp/connecting.mdx) walks through
  authorizing a client to read apps from HQ.
- [MCP access](../../../content/docs/mcp/access.mdx) explains what an HQ Import
  grant lets an authorized client read and bring in.
- [API keys](../../../content/docs/mcp/api-keys.mdx) identifies the HQ scopes a
  key needs for each operation.
- [Claude Code commands](../../../content/docs/claude-code/commands.mdx) covers
  `/nova:bring_in`, delivered by
  [nova-plugin #77](https://github.com/voidcraft-labs/nova-plugin/pull/77)
  once the Nova deployment is live.

### Proof and source evidence

- The [testing contract](../../testing.md) explains which checks belong to
  the Nova product, the browser and CommCare's own readers.
- The [proof guide](../../../proof/README.md) describes the 22 HQ-authored
  bases, their variants, coverage of the surface manifest, and the judge
  that compares predicted first-publish changes with what the readers observe.
  Proof 6 reads back the app from HQ after Nova publishes it.
- The [proof contract](../../../proof/CLAUDE.md) defines parity between
  the reader's accounting and the lane's independent classifier and the
  evidence for bringing in or recording a later HQ change.
- The [browser proof contract](../../../e2e/CLAUDE.md) covers the bring-in
  journeys and seeded apps.
- [Research findings](../../research/2026-09-26-hq-round-trip/harness-findings.md)
  track corrections from CommCare's readers.
- The [inventory index](../../research/2026-09-26-hq-round-trip/inventory/README.md)
  locates the reader and emitter evidence for each part of an app.
- [Application and settings](../../research/2026-09-26-hq-round-trip/inventory/application-and-settings.md)
  records what HQ keeps when Nova publishes.
- [Menus and case lists](../../research/2026-09-26-hq-round-trip/inventory/menus-and-case-lists.md)
  records how menu order, registration and list columns appear in the source.
- [Case search](../../research/2026-09-26-hq-round-trip/inventory/case-search.md)
  lists the source values for inputs and search results.
- [Forms and case writes](../../research/2026-09-26-hq-round-trip/inventory/forms-and-case-writes.md)
  distinguishes the case actions and session values the reader can identify.
- [Questions](../../research/2026-09-26-hq-round-trip/inventory/questions.md)
  records the bindings, text and appearance of each supported question.
- [Expressions and data](../../research/2026-09-26-hq-round-trip/inventory/expressions-and-data.md)
  identifies the instances that supply values in HQ's expressions.
- [Gates](../../research/2026-09-26-hq-round-trip/inventory/gates.md)
  records which HQ features depend on a plan privilege or project-space setting.

[Step 7](7-rest-of-model.md) is the final step. Its four design chapters cover the eight groups of
features that the reader reports as “Nova can't hold this yet.”

## Why each later step is planned when the one before it exits

Each defect part step 2 fixed that the lane reproduces was observed in the
system it harms, by a register entry, before its fix was designed in detail,
and step 2's proofs were written against the harness step 1 built rather than
one imagined in advance. Each later step is planned in full when the step
before it exits, against the code as it then stands.

## Rules every plan follows

- A plan states decisions as decisions. It names what Nova does today in the
  present tense and what changes as "from step N".
- One concept per meaning; no reference a reader of the repo cannot see.
- One name for bringing an app in. Wherever a person reads it, step 6's feature is "Bring in an app
  from CommCare HQ" and its verb is "bring in", never "import", which already names the files Nova
  sends to CommCare HQ and a CSV that replaces a table's rows. In code the reader produces a reading, with findings
  in an account or choices in a review. Adoption creates the app.
- A unit with incompatible persisted changes uses one direct maintenance cutover. Each of steps 1–6 is
  one unit. The research makes each feature group in step 7 its own unit for this rule. Groups with a
  shared incompatible representation land it together in one window. The cutover starts with the
  production scan (see `docs/architecture/contracts.md`) and
  leaves every document valid. One-off data migrations ship as a read-only scan
  script plus a separate migrate script in `scripts/`, which are removed after
  they run. Step 6 uses four ledgered migrations that apply while the previous
  revision serves. Each added document slot is optional or widens a grammar.
  Ownership of a lookup table in a project space comes from the Project's live
  deployment mappings. These changes require no maintenance window.
- No rollouts, flags, leases or transitional cutovers.
- Tests earn their boundary (`docs/testing.md`).
- Every CommCare fact a plan relies on is settled at source, in local
  checkouts of the Dimagi repositories at the commits `proof/pins.json` names
  when the plan is written, which the plan states. Step 2's, step 3's, step
  4's, step 5's and step 6's plans read commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`,
  commcare-android `7a5584475580`, commcare-connect `046c7fd78081` and formplayer
  `24383ac71bfb`, with Vellum `01215f251c57` (the build HQ vendors at that
  pin). The research cites commcare-hq `f57e85e02913` (with `525becc2963`
  where it names it), commcare-android `fd79cac4a0f1` and commcare-connect
  `4a200c9d9`; a plan re-verifies each fact it relies on at the pins it reads
  and cites those. A subagent's brief carries the
  same rules: search every checkout for every reader of a value, read each
  reader's enclosing condition, never read a repo through `git show` or raw
  URLs, never switch a shared checkout, and execute where reading leaves doubt.
- The repo is public. Plans never describe an HQ route a caller can use without
  a credential, or any other HQ weakness; client data and execution evidence
  stay out of the repo.
- A plan leaves `docs/plans/` when its step ships; what endures moves to the
  architecture docs or a subtree `CLAUDE.md`.

## Nova since the research

The research reads Nova `main` at `982d2630`. Step 2's plan read it at the
proof lane's merge onto `main`, which is `7b153dc3` or later. Between them:

- #699 and #701 (dependency upgrades, MCP OAuth scope challenges on the HQ
  tools, an MCP request-body cap) and the research itself (#698). From #701
  every MCP tool that reads or writes HQ declares its scope through
  `lib/mcp/scopes.ts::oauthScopeChallenge`, so each new or changed HQ-facing
  MCP tool in these steps does the same.
- #702 (worker journey evidence), and #703, these plans.
- #704 to #707, step 1: the native proofs in the pinned harness, the surface
  manifest with the flag probe reading its gates from it
  (`config/commcare-hq-feature-flags.json` and the weekly flag audit are
  gone), the proof lane with its register, and their docs. Two things moved
  that later plans name: what a publish sends is assembled only in
  `lib/deployment/importApplication.ts::hqImportApplication`, and a `.ccz`
  only in `lib/export/localArchive.ts::compileLocalArchive`; the lane's
  capture calls both.
- #712 (authoring and worker-app behavior). It fixed finding 52 by rewriting
  how a validation message is emitted (`lib/commcare/xform/constraintMessage.ts`):
  a plain message is written on the bind and as the control's `<alert>`, and
  one that shows an answer becomes the constraint-message expression, with a
  new emitted node `nova_constraint_message_<question>` and itext forms named
  `__nova_identity`, `__nova_mode`, `__nova_locale` and `__nova_piece_<n>`,
  none of which the research's list of emitted nodes names. It also added the
  previous-task projection to after-submit navigation
  (`lib/commcare/previousTaskProjection.ts`, `lib/domain/navigation.ts`).
- #717 and #722 (dependency upgrades; scripts now start with
  `import "./lib/loadEnv"`), #723 and #724 (the lane on hosted runners), and
  #716, which moved the upstream pins.
- #729 (case-write findings, in `lib/commcare/caseWriteFindings.ts`), #730 (a
  select's choices from the worker's available cases, a casedb itemset on
  both export paths, `lib/commcare/caseOptions.ts`), #732 and #733.
- #738, the proof lane's own pull request: every CommCare reader over Nova's
  exports, with the registers and the pins step 2's plan read.

Step 3's plan read `main` at `5cf6e327`. After `7b153dc3`:

- #727, step 2's plan, and #740, #741 and #748 (dependency upgrades with the
  docs search and editor popovers, the proof nightly's cold-cache start and
  shard failure reports, error evidence and authoring refusals).
- #749 to #767, step 2's stack, merged together ("Step 2 is done", above).
  Step 2 changed no stored expression vocabulary: what step 3 builds on is its
  rules over expressions (the time-of-day ordering refusal, the three system
  dates in CSQL with the blank-comparand guard, the both-quote-marks
  `'match-none()'` sentinel), `xpathQueryUsesRelatedLookup`, the case list's
  order plan, the question id grammar and `hiddenFromMenu` (`lib/commcare/CLAUDE.md`
  and `lib/domain/CLAUDE.md`).

Step 4's plan reads `main` at `e9e6cd93`. After `5cf6e327`:

- #769, step 3's plan, with #771 (the Android reader's own checks held to the
  standard library), merged beneath it.
- #773 to #791, step 3's stack, merged together ("Step 3 is done", above).
  What step 4 builds on is the one `Expression` union with its checker and
  slot profiles (`arm-unavailable` and its reasons), `DatumRef`, the instant
  lowering and its held classes, and Preview on the device's own XPath
  (["Step 4 is done"](#step-4-is-done), which records the baseline step 4's
  plan was written against).
- #798 and #799 (dependency upgrades and the supported APIs they bring) and
  #800 (the nightly lanes keep running past an independent reader's failure,
  and the native slices and reader checks it repaired).

Step 5's plan reads `main` at `2f985ed6`. After `e9e6cd93`:

- #803, step 4's plan.
- #805 (two smoke-suite races: editing before the builder is ready, and
  removing routes a handler still holds) and #802 (a body-parser bump).
- #809 to #825, step 4's stack, merged together ("Step 4 is done", above).
  What step 5 builds on is the declaration and the platform table
  (`appSettings.runsOnlyOn`, `lib/domain/platforms.ts`), the gate's
  `PLATFORM_FEATURE_UNAVAILABLE`, one search wire shape for every platform
  an app declares (`lib/commcare/suite/case-search/searchWireShape.ts::searchWireShape`),
  the `form-entry-sync-off` confirmation with its ledgered migration
  (`lib/case-store/migrations/20261101010000_hq_round_trip_platforms_form_entry_sync.ts`),
  the model step 5's `commtrack-off` follows, Preview per platform, and
  `RUNTIME_VERSION` 17.

Step 6's plan reads `main` at `1f103305`. After `2f985ed6`:

- #832, step 5's plan, and #833 (the proof lane's nightly reader failures: HQ answers a view's
  exception with its own `handler500` in the lane, as a deployed HQ does).
- #837 to #855, step 5's stack, merged together ("Step 5 is done", above). What step 6 builds on is
  one concept for a form's case writes (`Form.caseOperations`, the own case among them), the place
  each published case change holds and `lib/commcare/hq/publishedCaseBlocks.ts`, advanced modules,
  `caseSearchConfig.workflow` and `formsReadSearch`, `Module.caseListMenuItem` and
  `Module.caseListRegistrationForm`, `Form.otherwise`, `group.fieldList` and `plainLabel`, the
  `commtrack-off` confirmation and the `same-type-child-links` capability, an empty known-defect
  register, `MODEL_CONTEXT_VERSION` `v6-hq-round-trip-case-writes.13` (#852, the stack's last move
  of it) and `RUNTIME_VERSION` 18.
- #866 (a submission's values keep their meaning through SQL evaluation) and #867 (authoring reads
  no longer depend on case-write emission: `lib/commcare/formCaseEntryPlan.ts` holds what a form's
  entry needs, apart from `casePlacementPlan.ts`).
- #870 (fixed case scope indexes replace the per-property ones, so the case store derives no
  Postgres identifier from a case type or a property, which step 6's wider name grammars rest on).
- #878 and #879 (a choice question's starting value is held to its choices,
  `lib/commcare/validator/rules/selectPreloadWriterOptions.ts`, and its repair runs through the
  fenced maintenance Job).
- #880 (the Publish dialog's body is `components/builder/PublishDialogBody.tsx`, loaded when the
  dialog opens, with the destination chosen apart from the review), which step 6's connection check
  and first-publish list build on.
- #887 (authored prose stays literal through the XML export, `lib/commcare/xform/builder.ts`), which
  step 6's calculated values in prose build on.
- #874 and #888 (the lane: its search checks, the weekly audit's eligibility and setup, reader
  scheduling, named configuration slices for a run started by hand, and the pinned JDK).
- #902 and #903 (the lane: identity registers kept apart in a private proof run, nested logs
  retained, and HQ's own deployment timeouts for the lane's Elasticsearch requests). Both touch
  `proof/` alone.
- #860, #872 and #891 (dependency upgrades); #863, #864, #868, #869, #871, #873, #876, #877 and #896
  (observability, agent work limits, query batching, App Test journey bounds, OAuth issuer discovery
  for MCP clients, maintenance host matching, focus, unsaved edits on leaving, Cloud Run bounds);
  and #892 to #894 and #897 (chat sources and transcripts). Of these step 6 reads two facts. #893 and
  #894 hold the newest migrations on `main` (`20261112000000_incremental_transcripts`,
  `20261112010000_retained_conversation_sources`), which step 6's four migrations are stamped after.
  And #894 moved `MODEL_CONTEXT_VERSION` to `v6-hq-round-trip-case-writes.14` (`lib/models.ts`), the
  value step 6's one move of it replaces.

No defect the research lists changed behavior before `7b153dc3` but finding 52.
After it, #749 to #767 are step 2, which fixed defects 1 to 10 and 12 to 16 and
every finding of the harness it registered but finding 56; no other pull
request in that span changed a defect's behavior. After `5cf6e327`, #773 to
#791 are step 3, which fixed defect 17 and findings 56, 72, 73 and 75; no
other pull request in that span changed a defect's behavior. After `e9e6cd93`,
#809 to #825 are step 4, which fixed the second half of defect 11, defects 18
and 19, defect 20's sync on form entry and finding 74; no other pull request
in that span changed a defect's behavior. After `2f985ed6`, #837 to #855 are
step 5, which fixed defects 21 to 30, defect 12's links between cases of the
same type at publish and defect 20's CommTrack half, and left the known-defect
register empty. #878 widened the refusal that fixed finding 72, from a literal
default outside a choice question's options to every authored value that
reaches a choice question as its starting value
(`lib/commcare/validator/rules/selectPreloadWriterOptions.ts`, with the new
`SELECT_DEFAULT_VALUES_UNBOUNDED` for a value it cannot bound); no other pull
request in that span changed a defect's behavior.
