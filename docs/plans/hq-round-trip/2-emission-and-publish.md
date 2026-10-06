# Step 2: Emission and publish fixes (work items)

Step 2 fixes defects 1 to 16 and the harness's findings (defects 31 and up)
inside today's model, with the small model additions those fixes need, and
gives publish the version floor, the per-privilege confirmation and the drift
check. This plan fixes the step's scope, its work items, its one cutover and
its contracts. Step 1 is done but for the one clause work item H takes up, so
this step is planned in full next, down to files, schemas and tests, against
the harness step 1 built: the proof lane (`proof/README.md`) reproduces each
defect below that it observes and proves each fix, and its register
(`proof/known-defects.json`) is the list this step empties.

Nova's behavior at `29294f6a` matches the research for every defect here; the
only drift is inert. Since #696 and #697 Nova emits live repeat counts, so
`lib/commcare/constants.ts`'s comment on `RESERVED_XFORM_NODE_PREFIX` still
describes count snapshots, and `lib/commcare/xform/builder.ts::isRepeatCountSnapshot`
orders setvalues no emitter writes any more. Both go with defect 16.

## Model additions

Each is a complete feature when it lands: domain, validator, emitter, Preview,
builder, SA and MCP surfaces, and public docs.

- `Form.xmlns`, minted inside the creating mutation.
- `localization.wireCodes`: each language's HQ code, stored when the language
  is added.
- `showSavedForms` and `showIncompleteForms`, explicit app settings.
- `postSubmit: firstMenu` and `postSubmit: parentMenu`.
- The always-false display condition holding its rest: a `false()` or
  `false() and <rest>` condition is "not on the menu", and `DISPLAY_CONDITION_ALWAYS_FALSE`
  retires.
- A Hidden Value with neither a calculate nor a default. Every
  `HIDDEN_INERT_VALUE` default of `''` migrates to it and the constant retires.
  One that writes a case property writes it blank on each submission unless the
  form preloads that property into it, and the builder, SA and MCP say so where
  the author sets it.
- `uiStringOverrides` and `uiStringCatalogKeys`.
- A sort column on a lookup-backed search prompt, the display label by default.
- The media formats every platform plays (BMP, M4A, FLAC, WebM, Ogg Vorbis and
  Opus) added to the accepted set.

## Work items

### A. Identity (defect 1)

- The deployment ledger records, per target, each menu's `unique_id` and each
  form's `unique_id` and `xmlns` against the Nova entity, and every publish to
  that target writes them back.
- A create is followed, inside the same publish and before any build can exist,
  by an in-place update that writes Nova-minted menu and form ids; HQ's
  re-minted form ids are never observed.
- A `.ccz` for a project space uses that space's recorded ids; one for no
  project space, and the HQ import file, use `Form.xmlns` and ids derived from
  the Nova entities' UUIDs.
- `localization.wireCodes` replaces `lib/commcare/languageWire.ts::planLanguageWire`'s
  recomputation, so adding or removing a language never renames another's code.
- The comments that say HQ re-ids forms on import say it does so only on create.
- Removes: defect 1's register entries. Proof 1 passes on republish for every
  corpus document.

### B. The drift check and its baseline

- The ledger records, per target, the canonical app source Nova last pushed
  there. Before every publish, Nova reads HQ's current source (and form ids from
  `ApplicationResource` where the space has API access) and compares, by the
  research's rules in "Edits made in HQ": forms matched by position, target-owned
  keys and every key Nova's overlays leave at HQ's value ignored, form-id
  references compared as positions.
- A difference stops the publish. The person may discard HQ's change,
  confirmed; until step 6 Nova offers nothing else.
- The same check guards every lookup table and location Nova pushes: before a
  push Nova reads HQ's copy and stops if it changed since Nova's last push. The
  baseline belongs to the table or place in its project space, so a push from
  any app of the Project updates it.
- Publish states that HQ's App Preview may show a validation verdict up to 7
  days old for a form whose earlier version was rejected.

### C. Publish gates

- **Version floor.** Publish reads the target app's CommCare version and stops
  below 2.57. For a new app it creates the app, writes the in-place update that
  sets its ids, and then stops if HQ's default version is lower. The next step
  is to raise the version in the app's settings in HQ, and publish says that
  phones on an older CommCare can then no longer install or update the app.
- **Per-privilege confirmation.** Publish lists every privilege the app's
  content needs (from the manifest's gate entries), with the plans that carry
  each (`accounting/bootstrap/features.py`); the person confirms each once per
  app and project space; the ledger records it on the deployment record,
  revisitable from that target's settings; publish refuses without it.
  `commcare_logo_uploader` is the one privilege not confirmed (below).
- **The flag probe checks each gate where the manifest names it** (defect 12):
  `CASE_SEARCH_ADVANCED` for inline search, multi-select case lists, single-date
  prompts and `exclude` as well as hidden and default-valued prompts;
  `CASE_SEARCH_RELATED_LOOKUPS` for related-case filters; `CASE_LIST_TILE` and
  `CASE_LIST_TILE_CUSTOM` for custom tiles; `VIEW_FORM_ATTACHMENT` only for a
  link write shown in a case list or detail; `DONT_INDEX_SAME_CASETYPE` refusing
  an app that creates a basic child case of its own menu's case type, with the
  offered move to a Save to Case placement.
- **Whose credential reads a space's flags.** The publishing person's, where
  its user is a member; otherwise the deployment creator's while a current
  member of the Project, then other current members' in the order they joined,
  each read with another member's key recorded and shown to that member. Where
  none is a member, publish stops, naming the space, with the next step to join
  it. Publish names each flag it relies on.
- **Flat location fixture.** Publish writes `location_fixture_restore:
  project_default` and, for an app that reads locations, asks the person to
  confirm the flat fixture syncs, once per app and project space, recorded
  beside the privileges.
- **Logos** (defect 14). Publish writes no `logo_refs`; a publish that carries
  a new or changed logo offers the file and the step to upload it in the app's
  settings in HQ, where the plan has `commcare_logo_uploader`. The first publish
  to a deployment whose `logo_refs` hold Nova's path-only entries writes them
  once more without those entries, keeping any HQ's uploader wrote.
- Every gate is checked at publish, never at commit; the commit gate still reads
  only the document.

### D. Emission inside HQ's editable envelope

- **Defect 2:** form display conditions write the expanded casedb read.
- **Defect 3:** `case_references_data.save` carries Vellum's computation for
  every Save to Case block.
- **Defect 4:** `translations` as the closed owned set with HQ's value kept for
  every other key and an empty value only for an unoverridden catalog key;
  `add_ons` with each add-on the content needs set `true` and every other kept
  at HQ's value, read just before the upload; `auto_gps_capture` kept at HQ's
  value except where a Connect app needs `true`.
- **Defect 7:** `cc-show-saved` and `cc-show-incomplete` written explicitly.
- **Defect 8:** barcode and secret validations emitted.
- **Defect 9:** the `.ccz` profile declares `requiredMajor` 2 and
  `requiredMinor` 57, uses the Nova app's UUID as `uniqueid`, and the
  document's sequence as the profile, resource and app version.
- **Defect 10:** ID mapping emits `enum` sorted by mapping position, with HQ's
  key rule; the `.ccz` and Preview sort select columns by label and an unsorted
  list by its first column. The harness found two more variants, each fixed
  the same way: an interval column with text, which HQ sorts by its displayed
  text, and an image-map column, which HQ sorts by mapping position. An
  unsorted list differs between the paths only where HQ sorts its first
  column by something other than its text, a date or an image map
  (`harness-findings.md`, corrected claims 3 and 10). Where two columns share
  a property, HQ moves the sort to the first of them, which leaves the order
  alike and changes what a fuzzy search matches: finding 51 (work item G).
- **Defect 13:** every item of the research's list, including the renamed nodes
  (`nova_<purpose>`, "Nova's exports stay inside HQ's editable envelope"), the
  guards as Save to Case updates whose case id is `if(<ok>, <id>, '')`, groups
  carrying operation conditions, constraints on source questions, the untyped
  datetime leaf, root create ids as load-time values, relative default reads,
  shared case ids in hidden values, default-language text for empty
  translations, and the ref-less repeat group and empty `work_area_id`.
- **Defect 14:** `update_case: always` for non-writing follow-ups; close
  conditions a Case Management tab cannot state moved to a Save to Case block;
  the validator refusing the multi-select destinations; the search button label
  no longer offered; lookup prompt sort columns; reserved input names refused;
  survey menus keeping their case type; tile font sizes, positions and cell
  alignments (defect 42); the data node's `name` as the form's name; and the
  equivalent spellings.
- **Defect 15:** the validator narrows question ids, entry-point ids and Connect
  block ids to what HQ's editors accept, and refuses a question named `meta` in
  any case, which HQ's build also refuses (`harness-findings.md`, corrected
  claim 5).
- Each fix that makes the emitter write the editor's spelling removes the
  spelling rule step 1 registered for Nova's former spelling.
- **Defect 16:** the comments, types, SA descriptions and public docs say what
  is true; hidden columns are kept (and refused in a custom tile until step 7);
  hint media, label media on groups and repeats, and validation-message media
  are removed from the model; the dead code goes; the Hidden Value refusal says
  only that Nova does not yet write a default beside a calculate.

### E. Lookup data, CSQL and media

- **Defect 5:** adopting or pushing an HQ table with field properties, indexed
  fields, row attributes or owners, or one that is not global, is refused until
  step 7; tags containing `casedb` or `ledgerdb` are refused; HQ's "Upgrade
  Required" page is reported as nothing landed; the 31-character cap goes.
- **Defect 6:** the validator refuses an ordering comparison on a time in every
  slot, and in CSQL a blank check on `date_opened`, `closed_on` or
  `last_modified` and a comparison between them and a value that is not a date
  or datetime (or a runtime value with no guard against blank).
- **Defect 11, first half:** the formats every platform plays are accepted,
  MP4 and WAV acceptance is unchanged, and `mediaSuiteXml.ts`'s comment and
  `MediaRuntimeTest` describe archive installs correctly.

### F. The migration notice

A migration names every app and entity it changes in a notice on each affected
app, shown to its members until they dismiss it. Nova has no such notice today,
and step 2 is the first step whose migrations need one, so it builds it: a
per-app record written by the migrate script, shown in the builder and returned
by MCP's app reads, dismissible per member.

### G. The harness's findings

Every defect the harness found, numbered from 31 in
`docs/research/2026-09-26-hq-round-trip/harness-findings.md`, is this step's
to fix, beside defects 1 to 16. Each the lane reproduces is held by a register
entry, which its fix removes. They fall in the areas that file names:
building and installing (a form HQ will not build that Nova admits, the
local archive's `__APP_ID__` search URLs, case names trimmed on one export
path only, a Connect app's local archive capturing no location); case lists
(hidden select and sort columns, the order new cases reach a device, image-map
widths); the profile and settings (the local profile's current language, HQ's
settings page writing its defaults into the profile, the empty-list text
without English); HQ's editors (the Case List save's tile alignment, question
names and duplicate option values HQ's form builder refuses, Vellum's
rewrites of case reads and of the form's name, warnings about case
properties no form writes, a follow-up form drawing the registration alert);
search and publish (the mixed-quote CSQL function HQ does not have, the
missing-media warning under `CAUTIOUS_MULTIMEDIA`); and those the register
round found (a list's sort keys on different columns, which a fuzzy search
reads; HQ's exception report for each search Nova's zero-input sentinel
sends; and two differences only another runtime reads, both alike to it: the
Case List save's empty search description and a Vellum save's empty Connect
work area id). Finding 52, a validation message showing an answer that
reached the worker unfilled, is already fixed (#712), and the register holds
no entry for it.

### H. Step 1's open clause

Step 1's exit asks the register for an entry for every row of its defect
table, and every row has them. One clause of a row is not observed
(`proof/README.md`, "What the lane does not observe"): defect 3's "after
Vellum reports each `#case/<property>` as an unknown question", which no
corpus document shows, since none reads `#case/<property>` for a property
only Nova's Save to Case blocks write. Before defect 3's fix is planned in
full, either the lane observes it (a targeted document reading such a
property, its warning named apart from finding 47's by whether a Save to Case
block writes the property), or a decision recorded in this plan leaves it to
the fix's own tests.

## The cutover

One direct maintenance cutover, with its production scan first. It:

1. Mints `Form.xmlns` for every existing form locally, and stores each existing
   language's current wire code.
2. Reads every existing deployment from HQ, as the research's "Identity" gives
   it: each space's menu ids and `xmlns` from its app source and its form ids
   from `ApplicationResource`, with the credential order of work item C, the
   form and menu matching by shared question paths and position, the handling of
   spaces without API access, of HQ apps HQ reports deleted, and of deployments
   no credential can read, and a transient failure stopping the cutover before
   its first write.
3. Records each deployment's current source as its drift baseline, and each
   pushed table's and location's current HQ state as theirs.
4. Stores `showSavedForms` and `showIncompleteForms` from what the app's
   deployments show, as defect 7 gives it.
5. Applies each document migration defects 5, 6, 10, 13, 14, 15 and 16 name, and
   `HIDDEN_INERT_VALUE` defaults to the new Hidden Value state.
6. Writes a notice on every affected app, naming every app, entity and
   deployment each migration changed.

Its scan and migrate scripts ship in `scripts/` and are removed after they run
in production.

## Contracts

The research's contracts table, step 2 rows:

- `contracts.md` and root `CLAUDE.md`: the two further HQ facts that bind Nova
  (HQ's editors can produce and keep every app Nova emits; reading an app
  changes nothing HQ's servers or existing data depend on).
- Root `CLAUDE.md`: the document holds `Form.xmlns` and language wire codes as
  identities no author chooses.
- `lib/commcare/CLAUDE.md`: Nova reserves no names (`nova_<purpose>`), including
  `__nova_subcases` renamed `nova_subcases`; `location_fixture_restore:
  project_default` with publish's confirmation; HQ re-ids forms only on
  create, and every id comes from the ledger; `cc-show-saved` and
  `cc-show-incomplete` as app content written by overlay, and no `logo_refs`;
  the always-false condition in place of the soundness finding.
- `lib/media/CLAUDE.md`: the formats every platform plays.
- `lib/lookup/CLAUDE.md`: a 32-character tag pushes.
- `lib/deployment/CLAUDE.md`: a publish creates afresh after the cutover ends a
  deployment whose HQ app HQ reports deleted.

## Exit

An app created and then republished twice keeps every `xmlns`, form id and
module id in HQ, and every `xmlns` in the local `.ccz`; proofs 1 to 5 pass on
every Nova export for these defects, and the register holds no entry for
defects 1 to 10, 12 to 16, or 31 and up; publish refuses a target below the
floor or without a confirmed privilege; a second publish stops when HQ's copy
changed since the first.

## What step 2 inherits from step 1

The proof lane, its registers and controls, and the spelling rules for the
spellings Nova emits today. Each fix removes its defect's register entries and
any spelling rule it makes unnecessary, adds the identity moves it decides to
`proof/identity-moves.json`, and proves on the defect's control that the
check still sees the symptom there. A control runs today only while an entry
names it (`proof/checks/cases.py::control_params`), so the full plan settles
how a fixed defect's control keeps running.

## What the full plan settles

These follow from the decisions above and are settled against step 1's harness
and the code as it then stands:

- The ledger schema for per-target identities, confirmations and baselines, and
  where a baseline's source bytes are stored.
- How the publish panel and the MCP publish tool carry each confirmation and
  the drift discard, under `oauthScopeChallenge`.
- The pull-request stack and the order in which the fixes land inside the one
  cutover.
- Each fix's proof: which register entries it removes, the identity moves it
  adds to `proof/identity-moves.json`, the Nova tests for the parts whose harm
  is in no system the lane runs (`proof/README.md`, "What the lane does not
  observe"), and, for work item H's clause, the lane's observation of it or
  the recorded decision that leaves it to those tests.
