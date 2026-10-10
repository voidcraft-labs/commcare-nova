# Step 2: Emission and publish fixes

Step 2 fixes defects 1 to 16 and the harness's findings (31 and up) inside
today's model, with the small model additions those fixes need, and gives
publish the version floor, the per-privilege confirmation and the drift check.
It ships as one stack of pull requests, one maintenance cutover and one deploy.

This file is the plan: the baseline it was written against, every decision
that departs from the outline it replaces or from the research, the model
additions, the work items with where each is planned in full, the stack, the
cutover, the contracts and the exit. The detail (files, schemas, migrations,
register entries, tests) is in eleven part files beside it,
[`2-emission-and-publish/`](2-emission-and-publish/). A session implementing
one pull request reads this file, that pull request's row in part 11's stack
table, and every part "The stack" below names for it. Nothing here or there is left to decide during
implementation: where a design rests on reading alone, the part names the lane
run that confirms it and the fallback already chosen.

| Part | Holds |
|---|---|
| [01](2-emission-and-publish/01-identity-publish.md) | Work item A: derived ids, language wire codes, the publish sequence, downloads by project space, the HQ import file (defect 1; findings 32, 49, 59) |
| [02](2-emission-and-publish/02-ledger-drift.md) | The deployment ledger's schema, work item B (the drift check and its baselines), defect 5, correction 15 |
| [03](2-emission-and-publish/03-gates.md) | Work item C: the version floor, plan features, the flag probe (defect 12), the flat location fixture and logos (defect 14), findings 53, 64, 69, Data Forwarding and a Connect forwarder |
| [04](2-emission-and-publish/04-app-emission.md) | App-level emission: defects 2, 3, 4, 7, 8, 9; findings 34, 39, 40, 62, 65; work item H |
| [05](2-emission-and-publish/05-xform.md) | XForms: defect 13; findings 33, 37, 45, 46, 47, 55, 66 |
| [06](2-emission-and-publish/06-settings-navigation.md) | Menus, forms, navigation and search settings: defect 14; findings 41, 50, 54, 58 |
| [07](2-emission-and-publish/07-case-lists.md) | Case lists: defects 10 and 16 (hidden columns); findings 35, 36, 38, 42, 51, 57, 67 |
| [08](2-emission-and-publish/08-ids-data-media.md) | Identifiers, form content, CSQL, media and the model clean-up: defects 6, 11, 15 (with its Connect forwarding), 16; findings 31, 43, 44, 48, 56, 60, 61, 68, 70 |
| [09](2-emission-and-publish/09-proof.md) | Proving the fixes on the lane: the fixed-defect register, the rules, the entry accounting, the capture, the corpus; findings 63 and 67 and Connect's reading of a renamed block, as what HQ does itself |
| [10](2-emission-and-publish/10-cutover-notice.md) | The cutover and work item F (the migration notice) |
| [11](2-emission-and-publish/11-stack-contracts.md) | The stack in full, the model-addition checklist, contracts and docs |

## The baseline this plan was written against

**Nova.** `main` at `e7f74de1`. The research reads Nova at `982d2630`; the
README's "Nova since the research" lists what landed between. Every defect 1
to 16 and every finding 31 to 55 still reproduces as the research and
[`harness-findings.md`](../../research/2026-09-26-hq-round-trip/harness-findings.md)
describe, but finding 52, which #712 fixed. The evidence is the lane itself:
the Proofs gate passed on #716, at the pins below, with all 613 entries of
`proof/known-defects.json` unchanged, and the register is strict, so an entry
that stopped showing would have failed it. The parts re-read each defect's
code and state, block by block, where it has moved. What a fix must know:

- What a publish sends is assembled only in
  `lib/deployment/importApplication.ts::hqImportApplication`, which
  `proof/corpus/publish.ts` also calls; a `.ccz` only in
  `lib/export/localArchive.ts::compileLocalArchive`.
- The flag probe takes each flag's identity from the surface manifest
  (`lib/commcare/projectSpaceCompatibility.ts::HQ_PRIVATE_FEATURE_FLAG_SYMBOLS`,
  `lib/commcare/surface/gates.ts::domainFeatureFlag`). Which flags it checks,
  and for what content, is unchanged, so defect 12 stands.
- #712 rewrote validation-message emission
  (`lib/commcare/xform/constraintMessage.ts`). The emitter gained a node the
  research's list does not name, `nova_constraint_message_<question>`, and
  itext forms named `__nova_identity`, `__nova_mode`, `__nova_locale` and
  `__nova_piece_<n>`. Nova now writes the control's `<alert>` itself, so
  `proof/rules/vellum_alert.py` erases nothing Nova emits. #712 also removed
  finding 52's two entries and left its control,
  `expander-form-hashtag-expansion-declares-the-casedb-02e7ce76-0`, named by no
  entry.
- Inert, as the outline said: `lib/commcare/constants.ts`'s comment on
  `RESERVED_XFORM_NODE_PREFIX` still describes count snapshots, and
  `lib/commcare/xform/builder.ts::isRepeatCountSnapshot` orders setvalues no
  emitter writes. Both go with defect 13's rename (part 05).

**CommCare.** Every fact this plan relies on was read, and where reading left
doubt executed, at the commits `proof/pins.json` names: commcare-hq
`d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android `7a5584475580`,
commcare-connect `046c7fd78081`; Vellum `01215f251c57`, the build HQ vendors at
that pin; and formplayer `24383ac71bfb`, which the lane does not pin. HQ,
Android and Connect moved since the research. No fact the plan relies on
changed. One cited symbol moved: `cloudcare/views.py::_format_app_doc` is now
`cloudcare/utils.py::format_app_doc`. HQ gained the `AI_APP_TRANSLATION` toggle
and privilege and `OCS_CONNECT_INTEGRATION`, and `COMMCARE_CONNECT` now names
`SESSION_ENDPOINTS` and `CUSTOM_PROPERTIES` as parent toggles; none is a gate
Nova probes. Citations are `file::symbol`, HQ paths relative to
`corehq/apps/app_manager` unless another app is named.

**Executed during planning**, in the lane's HQ and against Core, because
reading left doubt:

- An HQ app created with no menus and then filled by an in-place update ends
  with exactly the ids and `xmlns` the update carried, no orphaned form, and
  HQ's default CommCare version (part 01).
- An import that carries no `multimedia_map` still maps every file of the
  media upload, builds the same media suite, and draws no missing-media
  warning (part 01).
- Two reads of an unchanged app's source differ only in form ids and the
  references to them, and each form's bytes are the bytes Nova uploaded (part
  02).
- A `replace=false` lookup upload re-creates a table that holds no rows, so it
  cannot serve as a harmless probe (part 02).
- A datetime compared for order on a device never orders by instant (finding
  56, part 08).
- A case list column over `case_id` is blank on HQ's build (finding 57, part
  07).

## What changed from the outline, and why

The outline this file replaces fixed the step's scope. Planning it in full,
against the code and the lane as they stand, changed these. Each is a
decision; the part named gives its evidence.

**Decided with the person (2026-10-06).**

1. **A form's `xmlns` is derived, not stored.** The ids Nova mints for HQ are
   a pure function of the Nova entity's UUID (`lib/commcare/wireIdentity.ts`):
   a menu's and a form's `unique_id` is the UUID without hyphens, and a form's
   `xmlns` is `http://openrosa.org/formdesigner/<UUID, upper case>`. A stored
   copy would hold nothing the UUID does not, on every form of every app.
   `Form.xmlns` leaves this step's model additions; step 6 adds an optional
   stored `xmlns` for a form read from HQ. The ledger records only the ids a
   project space holds that differ from the derivation (part 01).
2. **UI string overrides and `uiStringCatalogKeys` leave step 2.** Step 2 owns
   only HQ-generated app-string ids and language names in `translations` and
   carries HQ's value for every other key, runtime UI-catalog keys included,
   so a UI translation saved in HQ survives a republish. The override model
   joins step 7's application-and-settings group (part 04).
3. **Finding 33 converges by trimming on both paths**: an emitted hidden value
   `nova_trimmed_<question>` that HQ's basic actions read, with the nonblank
   and 255-character check on the source question (part 05).
4. **Finding 50 is what HQ does itself.** HQ shows the same alert for the same
   shape made in its own editors, and no spelling inside the envelope removes
   it. Proof 4 gains a closed, proven allowance for exactly that alert, and the
   finding moves under "What HQ does itself" (part 06).
5. **The cutover's HQ reads run in one Job with a decrypt-only, expiring
   grant**, after one advisory run of the same reads (part 10).
6. **At publish only the publisher's own key reads a project space's flags.**
   Publish already reaches only spaces that key belongs to, so the outline's
   fallback to other members' keys could run only for a lapsed membership, and
   would use one member's credential for another's action. The fallback order
   is the cutover's alone. Publish names capabilities, never HQ flag names: the
   outline's reason for naming flags (a flag on for the person alone) cannot
   occur for the flags Nova probes (`corehq/toggles/__init__.py::StaticToggle.enabled`)
   (part 03).
7. **Finding 40's settings are written at today's device behavior** (part 04).
8. **A `.ccz` for an app that searches needs a published project space.**
   Downloads gain a project-space choice (part 01).

**Decided in planning.**

9. **A first publish creates an empty HQ app and fills it with the ordinary
   in-place update.** The outline's create-then-update left HQ-minted form ids
   and an orphaned copy of every form behind. An app with no menus cannot be
   made into a saved build, so none can exist between the two calls (part 01).
10. **The version floor stops a new app before anything else is written**: the
    shell is created and read first, ahead of the lookup tables and places, so
    a target below the floor holds an empty app and nothing more. The outline
    wrote ids first. The version is read from the app source (part 03).
11. **The drift baseline is HQ's own reading taken after Nova's push**, where
    the outline stored what Nova sent. Only reading against reading needs no
    model of HQ's defaults. A save in an HQ editor that changes no value can
    therefore stop the next publish; that is accepted and said where it stops
    (part 02).
12. **Publish does not compare form ids through `ApplicationResource`.** A
    source read re-mints them, every publish writes Nova's verbatim, and the
    check's only remedy would be that same write (part 01).
13. **No lookup definition probe; defect 5's refusal reads what an API key can
    see.** An indexed-field flag and a table description are returned by no
    key-usable read, so the adoption and discard confirmations say Nova's push
    removes them (part 02).
14. **`DONT_INDEX_SAME_CASETYPE` moves to step 5.** No Nova document can hold a
    basic child case of its own menu's case type before then (part 03).
15. **Finding 53 keeps the sentinel and sends it on both paths**, without newly
    requiring `CASE_SEARCH_ADVANCED` for every search filter: HQ's own Case
    List page writes that filter without the flag (part 03).
16. **Defect 16's tile clause is corrected.** A column hidden from Results is
    usually shown on Details, so the research's refusal and removal would
    delete fields workers see. Nothing is removed for it; one shape with no
    in-envelope spelling is refused (part 07).
17. **Defect 13's leaf constraints are deleted, not moved.** Core evaluates a
    constraint only for a question a worker answers, so the ones Nova writes on
    case leaves never ran (part 05).
18. **Blank translations take Vellum's own fill rule at emission**, in the
    emitter and Preview alike, and no authored text is deleted (part 05).
19. **"Not on the menu" is a flag beside the display condition**
    (`hiddenFromMenu`), holding the condition as its rest, in place of an arm
    of the condition (part 06).
20. **Defect 6's runtime values are guarded by the emitter**, not refused and
    migrated: no Predicate spells that guard in a CSQL slot (part 08).
21. **Work item H is settled by observing it**, with the closing decision
    recorded if the lane shows no class of its own (part 04).
22. **A fixed defect's control keeps running under a second register**,
    `proof/fixed-defects.json`, and `proof/identity-moves.json` stays empty
    (part 09, and "Proof", below).
23. **The cutover is a fold-horizon cutover** (part 10).
24. **Additions the research does not name**: a sort-ownership rule
    (`CASE_LIST_SORT_PROPERTY_AMBIGUOUS`), case operation ids and link
    identifiers under defect 15's narrowing, `parsererror` beside finding 43's
    names, `indices.` among the reserved search input names, a no-matches
    form's `app_home` migrating to `firstMenu`, and document migrations for
    findings 31, 43 and 44. `case_preload` is not touched: its editable
    spelling is defect 28's, in step 5.

**Two findings from planning.** Both were found by reading while this plan was
written, then executed. Pull request 1 adds each to `harness-findings.md` with
a targeted document, register entries and a control.

- **Finding 56.** An ordering comparison on a datetime never orders by instant
  on a device. Step 2 holds it in the register; its fix is step 3's, whose
  typed expressions know each operand's type (part 08).
- **Finding 57.** A case list column over `case_id` is blank on HQ's build, and
  a hidden sort carrier over `case_id`, `owner_id` or `status` stops HQ's Case
  List page saving. Fixed in step 2 with the case-list work (part 07).

## Findings the lane's readers showed

The lane's branch (`proof/run-every-reader`) runs every reader the plan had cited: Formplayer and HQ's Web Apps client over every served state, Connect's receiver behind HQ's own repeater, and commcare-android in its own stage. What they showed, with its owner; each owner's block holds the run that observed it and the entries it moves.

- **Finding 58**, a link to a target its menu hides: Core opens it, Formplayer and the client stop. `hiddenFromMenu`'s design follows each runtime (part 06, 11 and 15).
- **Finding 59**, a local `.ccz` names no server: every `.ccz` is compiled for a reached project space and writes the four server properties (part 01, A5).
- **Findings 60 and 61**, Connect block names and a deliver form that holds a task: the validator refuses both, with their migrations (part 08).
- **Finding 62**, HQ's App Settings save takes the Incomplete Forms tile off Web Apps: Nova writes both form-list settings into the stored app on every publish (part 04, Defect 7 and finding 62).
- **Finding 63**, HQ's build installs on Android only with its media, and **finding 67**, an incomplete form under grouped tiles cannot be reopened for a case with no connection: what CommCare does itself (part 09; part 07 for 67's copy and its upstream report).
- **Finding 64**, no lane app was one Web Apps lists: closed on the lane's branch by granting `CLOUDCARE` in every configuration (part 03, C7).
- **Findings 65 and 66**, texts and update order the local archive writes otherwise than HQ's build: the local archive writes what HQ's build writes (part 04; part 05).
- **Finding 68**, a read of a session datum no Nova session supplies: the validator refuses it, with a migration (part 08).
- **Finding 69**, a device and Web Apps read the location fixture choice apart: `project_default` with the confirmation makes them alike, and the copy names Web Apps (part 03, C5).
- **Correction 15**, HQ answers a 33-character tag with a 500: Nova holds the 32-character cap itself (part 02).
- **Defect 15's Connect forwarding**: HQ never resends a delivery Connect refused, so the rename notice and the runbook ask for the new payment unit before the next publish, and Connect's reading of a renamed block is what Connect does itself (part 08; part 09).
- **Data Forwarding and a Connect forwarder**: publish asks the person to confirm both for a Connect app, since no API key reads either (part 03, C8).

Finding 70 is planning's: question names HQ's editors warn about (part 08).

## Model additions

Each is a complete feature when it lands: domain, validator, emitter, Preview,
builder, SA and MCP surfaces, and public docs. Part 11's checklist is the list
of places every addition touches.

| Addition | Part |
|---|---|
| `localization.wireCodes`: each language's HQ code, carried by the mutation that adds the language and stored with it | 01 |
| `appSettings.showSavedForms` and `appSettings.showIncompleteForms` | 04 |
| `postSubmit: firstMenu` and `postSubmit: parentMenu` | 06 |
| `hiddenFromMenu` on a menu and on a form, holding the display condition as its rest; `DISPLAY_CONDITION_ALWAYS_FALSE` retires | 06 |
| A Hidden Value with neither a calculate nor a default; `HIDDEN_INERT_VALUE` retires | 08 |
| A sort column on a lookup-backed search input, the display label by default | 06 |
| Required alignment and font size on a tile cell | 07 |
| The media formats every platform plays (BMP, M4A, FLAC, WebM, Ogg Vorbis and Opus) | 08 |

Removed from the model: the search button label (part 06); hint media, label
media on groups and repeats, and validation-message media (part 08). Not added
in this step, against the outline: `Form.xmlns`, `uiStringOverrides` and
`uiStringCatalogKeys` (above).

## Work items

| Item | What it settles | Part |
|---|---|---|
| A. Identity | Derived ids; the sparse per-target identity ledger; the shell create and the publish sequence; wire codes; a `.ccz` for a project space; the HQ import file | 01 |
| B. Drift | The baselines for the app, each pushed table and each pushed place; the stop and the confirmed discard | 02 |
| C. Publish gates | The version floor; plan features; the flag probe; the flat fixture; logos | 03 |
| D. Emission inside HQ's editable envelope | Defects 2, 3, 4, 7, 8, 9, 10, 13, 14, 15, 16 | 04 to 08 |
| E. Lookup data, CSQL and media | Defects 5, 6, 11 (first half) | 02, 08 |
| F. The migration notice | Its tables, surfaces and copy | 10 |
| G. The harness's findings | 31 to 57, each in the part that owns its code | 01 to 08 |
| H. Step 1's open clause | Observed in pull request 1; closed with findings 45 and 47 | 04, 09 |

Every gate is checked at publish, never at commit; the commit gate still reads
only the document.

## Proof

Part 09 holds this in full.

- **A fix moves its entries to `proof/fixed-defects.json`** in the same pull
  request. A fixed entry names no document: it must keep showing on its
  control, which retains the bytes Nova sent before the fix. That is how the
  lane keeps proving the check sees the symptom, where today a control stops
  running once no entry names it. A test requires every control directory to
  be named by one of the two registers.
- **`proof/identity-moves.json` gains no entry in step 2.** Proof 1 compares
  two exports of one document by one revision, so a migration or an emitter
  change moves both sides alike and no move can show there. The identities
  that move once for existing deployments are listed in part 09 and held by
  the cutover's tests over frozen pre-step fixtures (part 10).
- **Nine spelling rules retire** with the fixes that make the emitter write the
  editor's spelling; 24 stay. Part 09 gives each rule's verdict.
- **Step 2 empties 454 of the register's 613 entries.** The 159 that remain are
  later steps' (defects 20, 21, 23 to 28 and 30); some are re-pathed onto new
  controls where a step 2 fix moves what they name.
- **The harness keeps publishing as Nova publishes**: the capture and the
  publish sequence change in the same pull request, and retained controls are
  replayed in the layout they were captured in.
- **The cutover is outside what the lane observes**: its A and B come from one
  revision and it holds no Nova database. Nova's own tests carry it (part 10).

## The stack

One `gh stack` chain on latest `main`, each pull request reviewed and
undrafted, merged together for one deploy. Part 11 gives each pull request's
files, entries, rules, transform steps and ordering constraints.

| # | Pull request | Parts |
|---|---|---|
| 1 | Lane mechanics: the fixed-defect register; `vellum_alert` retired; finding 50's allowance; targeted documents and controls for work item H and findings 56 and 57; `targeted-hq-side-state` split; controls replayed in their capture layout | 09, with 02 (the split), 04 (work item H), 06 (finding 50), 07 (finding 57), 08 (finding 56) |
| 2 | The cutover's skeleton, the notice, frozen pre-step fixtures, every ledger table | 10, 02 |
| 3 | Identity and the publish sequence | 01, 09 (the capture) |
| 4 | Drift and baselines | 02, 09 (the retained reads) |
| 5 | App-level emission | 04, 02 (the ownership descriptor) |
| 6 | XForms, first part: shadows, leaf constraints, datetime leaves, the root create id, defaults, translations, the form's name | 05 |
| 7 | XForms, second part: groups, the rename, guards, conditions; defect 23's and 24's entries re-pathed | 05, 09 |
| 8 | Defect 3 and work item H's closure | 04 |
| 9 | Case writes through basic actions: findings 33 and 37, `update_case`, close conditions | 05 (findings 33, 37), 06 (`update_case`, close conditions) |
| 10 | Identifiers and form content: defect 15; findings 31, 43, 44 | 08 |
| 11 | Case lists, with findings 41 and 54 | 07, 06 (findings 41, 54) |
| 12 | Menus, navigation and search settings, with finding 53 | 06, 03 (finding 53) |
| 13 | Publish gates | 03, 01 (the shell's keys), 02 (the confirmation store) |
| 14 | Lookup, CSQL, media and the model clean-up | 02 (defect 5), 08 |
| 15 | Contracts and public docs | 11, and each part's docs and contract lines |
| 16 | Removal of the cutover tooling | 10 |

Every pull request also reads part 09 for what its fix does to the register,
its controls and the corpus, and part 10 for the transform step and notice
reason it adds. Each pull request that changes a stored shape adds its
transform step and its notice reason. Each fix moves its entries and retires its rule in the same pull
request. Each validator narrowing emits the corpus before and after, compares
the document ids, and rewrites or removes what it refuses. A pull request that
changes a tool's input schema asks the person before `npm run test:schema`,
which bills.

## The cutover

One direct maintenance cutover (`docs/architecture/contracts.md`), planned in
full in part 10.

- **A fold horizon.** Step 2 removes keys stored documents and history rows
  carry (the three media slots, the search button label), so an old document
  does not parse under the new schema and an old row does not replay. The
  cutover gives every app a new baseline at the final shape, marker
  `fold-baseline:hq-round-trip-emission`.
- **One Job, one fleet transaction.** `scripts/scan-hq-round-trip-cutover.ts`
  reports and writes nothing; `scripts/migrate-hq-round-trip-cutover.ts`
  rehearses, then executes against a plan digest. Both are removed by the
  stack's top pull request, and the cutover runs before the merge from the
  image of the pull request beneath it, so there is one deploy.
- **It reads every existing deployment from HQ** before its first write: menu
  ids, `xmlns` and source from the app source, form ids from
  `ApplicationResource`, each pushed table and place. A transient failure
  stops it before that write. It records the ids each project space holds, the
  drift baselines, and whose key read what. A deployment no key can read keeps
  its HQ app and takes derived ids, so its ids and `xmlns` change once at its
  next publish, as the research's "Identity" decides; the operator reviews
  that count before the cutover executes.
- **It migrates each document** through one ordered list of transform steps,
  one per fix that changes a stored shape, and proves the result under the new
  schema and the full validator.
- **It writes a notice on every affected app** (work item F), naming every
  entity and deployment it changed and each change that needs no write but
  alters what people see.
- **People lose unsaved private work**: open assistant workspaces, and edits a
  builder tab had not saved. The window is announced.

## Contracts

Part 11 gives each sentence as it reads today and its replacement. In brief:

- `contracts.md` and root `CLAUDE.md`: two further HQ facts bind Nova (HQ's
  editors can produce and keep every app Nova emits; reading an app changes
  nothing HQ's servers or existing data depend on).
- Root `CLAUDE.md`: the document holds language wire codes as identities no
  author chooses. A form's `xmlns` is derived and is not among them.
- `lib/commcare/CLAUDE.md`: Nova reserves no question names (`nova_<purpose>`);
  `location_fixture_restore: project_default`; HQ re-ids forms only on create,
  and Nova's ids are derived, with a project space's own ids from the ledger;
  `cc-show-saved` and `cc-show-incomplete` as app content written by overlay,
  and no `logo_refs`; `hiddenFromMenu` in place of the soundness finding;
  runtime request destinations name a real project space or nothing.
- `lib/media/CLAUDE.md`: the formats every platform plays.
- `lib/lookup/CLAUDE.md`: a 32-character tag pushes.
- `lib/deployment/CLAUDE.md`: an HQ app is gone on a 404 or a deleted document
  type; a publish creates afresh after the cutover ends a deployment whose HQ
  app is gone; publish names capabilities.
- `lib/db/CLAUDE.md`: this horizon's baseline identity, and the notice tables.

## Exit

- An app created and then republished twice keeps every `xmlns`, form id and
  menu id in HQ, and every `xmlns` in the local `.ccz`.
- Proofs 1 to 5 pass on every Nova export for these defects. The register
  holds no entry for defects 1 to 10 or 12 to 16, and none for a finding from
  31 up but finding 56, which step 3 fixes. Findings 50 and 67 and Connect's
  reading of a renamed block leave as what HQ does itself, by their allowances.
- Every control directory is named by a register, and every fixed entry shows
  on its control.
- Publish refuses a target below the floor or without a confirmed plan
  feature, and a second publish stops when HQ's copy changed since the first.
- Every existing app is valid under the new schema and validator, and carries
  its notice.

## What could not be settled from this machine

Each is stated where it bears, with what settles it.

- **Whether production HQ's default CommCare version is at least 2.57.** It is
  server data. The advisory scan prints every deployment's version; a new app
  below the floor stops with the step to raise it in the app's settings in HQ
  (part 03).
- **Who holds decrypt on the HQ-keys KMS key in production.** One IAM policy
  read during the runbook (part 10).
- **Whether Web Apps follows an after-submit link to an item that is not on
  the menu.** Reading formplayer
  (`services/MenuSessionFactory.java::rebuildSessionFromFrame`) says its
  end-of-form rebuild stops at the menu holding it, where the research's table
  says it runs. The lane does not run Formplayer. Part 06 states it as read and
  keeps the builder's, the tools' and the docs' wording platform-specific.
- **Reading-only designs the lane confirms in their pull request**, each with
  its fallback already chosen: Vellum's control-order rule on the new groups
  (part 05), the close-condition answer clause (part 06), and the handful part
  07 lists for case lists.
- **Not exercised by any control**: a shadow form's parent id, schedule phase
  form ids and report config uuids across two source reads. Nova emits none.
