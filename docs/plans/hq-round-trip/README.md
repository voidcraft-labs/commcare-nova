# HQ round trip: the plans

These plans carry out the HQ round-trip research
([`docs/research/2026-09-26-hq-round-trip/`](../../research/2026-09-26-hq-round-trip/README.md)):
Nova imports any app CommCare HQ's editors can build, holds it typed, edits it,
and publishes it back. The research is the design. Its "Order of work" gives
seven steps, each with one cutover, and these plans follow that order. Where a
plan cites a defect, a section or a contract row, it means the research's
"Defects in Nova today", its section of that name, or its "Contracts this work
changes" table.

| Step | Plan | Depth |
|---|---|---|
| 1 | The manifest and the harness | done: [`proof/README.md`](../../../proof/README.md) |
| 2 | Emission and publish fixes | done: [`lib/commcare/CLAUDE.md`](../../../lib/commcare/CLAUDE.md), [`lib/deployment/CLAUDE.md`](../../../lib/deployment/CLAUDE.md), [`proof/README.md`](../../../proof/README.md) |
| 3 | Expressions | done: [`lib/domain/CLAUDE.md`](../../../lib/domain/CLAUDE.md), [`lib/domain/expression/CLAUDE.md`](../../../lib/domain/expression/CLAUDE.md), [`lib/commcare/CLAUDE.md`](../../../lib/commcare/CLAUDE.md), [`proof/README.md`](../../../proof/README.md) |
| 4 | Platforms | done: ["Step 4 is done"](#step-4-is-done) |
| 5 | [Case writes, forms and navigation](5-case-writes-forms-navigation.md) | outline |
| 6 | [Import](6-import.md) | outline |
| 7 | [The rest of the model](7-rest-of-model.md) | outline |

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
  sensitivity checks, proofs 1 to 5, each judged over every reader), the
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
- **What step 3 left to later steps**, each with its reason, in
  [`5-case-writes-forms-navigation.md`](5-case-writes-forms-navigation.md),
  [`6-import.md`](6-import.md) and [`7-rest-of-model.md`](7-rest-of-model.md);
  what step 4 took of it is in ["Step 4 is done"](#step-4-is-done).
- **The cutover's trace.** The cutover ran once, before the merge, and its
  scripts, its Job and its runbook are removed. What it left is each app's
  `fold-baseline:hq-round-trip-expressions` row (`lib/db/CLAUDE.md`), each
  app's notice (`lib/notices/`) and its evidence archive
  (`docs/architecture/deployment.md`, "Historical repairs").

Finding 74 was held by two walk stops, on `targeted-datetime-ordering` and
`fuzz-xform-20260930-0`, and step 4 closed it. Step 4 declares both documents
Android only, so the stop on the first is held on its retained control in
`proof/walk-stops.json` and the second is removed (["Step 4 is
done"](#step-4-is-done)). The register's other entries are defects 21, 23 to
28 and 30, which `OPEN_DEFECTS` gives to step 5.

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
  confirmation and defect 21 in
  [`5-case-writes-forms-navigation.md`](5-case-writes-forms-navigation.md);
  the split's read-back and the guarded and `current()` reads in
  [`6-import.md`](6-import.md); a child module of a search-first parent,
  `fingerprintquery` and an ordinary search's results detail in
  [`7-rest-of-model.md`](7-rest-of-model.md).
- **The baseline step 4's plan was written against**: `main` at `e9e6cd93`,
  which is step 3's stack (#773 to #791) merged and its cutover run, then
  #798, #799 and #800, at the CommCare pins named under "Rules every plan
  follows".
- **The cutover's trace.** The cutover ran once, before the merge, and its
  scripts, its Job and its runbook are removed. What it left is the five
  ledgered migrations of step 4 with `mediaFormat.postgres.test.ts`
  (`lib/case-store/migrations/`); `lib/doc/platformDeclaration.ts`, which
  the fuzz mapping and step 6's import proposal read; each changed app's
  `blueprint-migration` row by `system:hq-round-trip-platforms`
  (`lib/db/CLAUDE.md`); each affected app's notice, cutover
  `hq-round-trip-platforms`, whose copy stays so stored rows render
  (`lib/notices/`); and its content-free evidence archive
  (`docs/architecture/deployment.md`, "Historical repairs").

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
- One cutover per step. A step that changes the stored shape of Nova documents
  migrates all of that step's changes in one direct maintenance cutover
  (`docs/architecture/contracts.md`), with its production scan first, and
  leaves every document valid. One-off data migrations ship as a read-only scan
  script plus a separate migrate script in `scripts/`, which are removed after
  they run.
- No rollouts, flags, leases or transitional cutovers.
- Tests earn their boundary (`docs/testing.md`).
- Every CommCare fact a plan relies on is settled at source, in local
  checkouts of the Dimagi repositories at the commits `proof/pins.json` names
  when the plan is written, which the plan states. Step 2's, step 3's and
  step 4's plans read commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`,
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

No defect the research lists changed behavior before `7b153dc3` but finding 52.
After it, #749 to #767 are step 2, which fixed defects 1 to 10 and 12 to 16 and
every finding of the harness it registered but finding 56; no other pull
request in that span changed a defect's behavior. After `5cf6e327`, #773 to
#791 are step 3, which fixed defect 17 and findings 56, 72, 73 and 75; no
other pull request in that span changed a defect's behavior.
