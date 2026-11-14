# Step 6: Bringing an app in from CommCare HQ

Step 6 lets a person bring in an app from CommCare HQ. They choose an app in a project space they are
connected to, and Nova reads it. Where Nova can hold all of it, they review what will be created and
get a Nova app that holds the whole app typed, edits like any other, and publishes back to that same
CommCare HQ app. Where it cannot, they get one account of everything that keeps the app out, grouped
by where it sits in their app, with what to do about each thing. An app comes in whole or not at
all: one Nova held part of would lose the rest at its first publish. A read that cannot finish (no
connection, no API access, a linked app) stops and says why, with nothing created.

Changes made later in CommCare HQ come in too. Where Nova holds nothing unpublished, they come in
with no warning and nothing Nova holds is lost, which is the round trip: Nova to CommCare HQ, an edit
there, back to Nova, back to CommCare HQ. Where Nova holds unpublished changes, the person is shown
what changed in CommCare HQ and exactly what taking its version removes, and chooses one side whole.
Nova also checks CommCare HQ when the builder opens an app, after the builder is drawn and usable,
and nothing waits on that check (part 15, section 8).

**The experience in brief.** Part 13 holds every screen and string, and part 15 the ones about a
later change. Four rules run through all of it. Every finding the reader can decide is reported in
one pass, so a person fixes one list and not one refusal after another; what stands beneath
something Nova could not read is judged at the next check, and every account says a later check may
find more (part 06, Departure 11). Nova's limits are worded as Nova's: only what CommCare HQ itself
would refuse or break on is "Something to change in CommCare HQ". Every finding, stop and refusal
carries a next step. And no confirmation is asked that the source project space already answers:
the review has no ticks, and where the app runs is a preselected choice.

This plan replaces the outline `6-import.md`, which this pull request removes; it is readable at
`main` `1f103305`, and every part cites it as "the outline", by item.

**How to read it.** The fifteen parts in [`6-bring-in/`](6-bring-in/) bind on what they design. This
file holds only what no part holds, which is what is agreed before the work starts and what spans
the parts, and it binds on that: what needs a yes, the order of work, the rules of "Checks before
the merge", the migrations' order, the versions and the exit. On anything else, where a sentence
here and a part differ, the part stands. One session implements the step, reading this file and all
fifteen parts, and it divides the work itself.

## What needs your yes before this starts

One yes covers this list. Nothing else in the step asks a person anything: every check's outcomes
are written in the part that owns it, with what the session does for each. Two outcomes end in a
stop and a report, never in a question: a saved app or a claim that a new rule refuses, found by a
scan or by the deploy's own checks (item 1), and a tool definition the provider still refuses after
three sends (item 2).

**1. Three read-only scans of production, each run once more just before the merge, and two of
them once more when the deploy has ended.** Each ran during planning and found nothing. Each runs
with `--prod` through `scripts/lib/prodDb.ts`, as your gcloud identity, writes nothing, and its
output is never committed.

| Scan | What it looks for | What it prints | Why it is needed |
|---|---|---|---|
| `scripts/scan-case-list-registration-registrations.ts` (part 02, section 16) | a saved app whose case list registration form also creates a case of the list's own type at its root | the id of each such app, and nothing else | `several-registrations` is the one rule of part 02 that could refuse a saved app |
| `scripts/scan-instance-text.ts` (part 03, section 5.1) | a saved app whose form name, CommCare Connect block name or description, or choice value (of a question or of a case property's catalog) holds text CommCare HQ's build reads as a data source | the id of each such app: no name, no form, never the text | the gate rule `FORM_TEXT_READ_AS_INSTANCE` and the choice value grammar's refusal are absolute |
| `scripts/scan-hq-app-claims.ts` (part 10, "Written and not yet run") | a CommCare HQ app that two live Nova apps publish to | two counts and nothing else: the CommCare HQ apps that two or more live Nova apps publish to, and those that several Nova apps publish to with at most one of them live | the ledger migration's unique index admits one |

**The runs, and what each is for.** A scan says what production held at the moment it ran. Until
the deploy finishes, the revision that serves is `main` before the step, and it still admits each
shape a new rule refuses. So an app saved after a scan can hold one, and one run cannot stand for
the whole deploy. Three things hold it between them, and none of them asks a person anything.

- **The run just before the merge**, of all three scans. It is what keeps the step from merging
  over a saved app, or a claim, that a new rule refuses.
- **The deploy's own two checks**, for whatever is saved between that run and the migration Job.
  The ledger migration's guard raises on a CommCare HQ app that two live Nova apps publish to, and
  since the batch is one transaction none of the four migrations is applied (part 10, section 11,
  statement 8). After the migrations commit, the same Job runs the incoming gate over every saved
  app and fails on any finding (`lib/db/runtimeDatabaseProbe.ts::runCanonicalRuntimeDatabaseProbe`,
  whose `auditRuntimeProbeParsedBlueprint` counts the findings of an empty batch through
  `mutationCommitVerdict`). Either failure fails the Job, which blocks the deploy: the previous
  revision keeps serving and no saved app is changed. After a probe failure that revision serves
  over the four migrations, which "Migrations and the deploy" argues it can.
- **The run when the deploy has ended**, of the registration scan and the instance text scan.
  Where the deploy is live, it covers the one stretch nothing above does: from the probe until the
  new revision holds all traffic, the previous revision can still save such an app. Where the probe
  refused the deploy, it names the app, since the probe's report holds counts and no id. The claim
  scan runs then only where the guard refused the deploy, to give its two counts. It has no run
  after a deploy that went through: from the migration on, the unique index holds one CommCare HQ
  app to one live Nova app against both revisions (part 10, section 11), and the scan's question
  is asked of the schema before the migration, where a mapping an app has since given up would
  count as a second claim and is none.

The three scripts leave the tree in the last commit before the merge (exit check 9). For the later
run the session writes the scripts it needs back into its working tree from the commit before that
one (`git show <commit>:<path>`), untracked, over the merged tree, runs them and deletes them, so
nothing is committed.

**If a scan finds something.** No part plans a repair or the handling of a duplicate: each scan
found nothing, and no product path writes what the claim scan counts (part 10, "Written and not yet
run"). At either run, where the registration scan or the instance text scan prints an app, or the
claim scan's first count is above zero, the session stops and reports what the scan printed, which
is ids or counts alone. Before the merge, nothing merges. After a deploy the probe or the guard
refused, production is as the bullets above leave it. After a deploy that is live, the app is as
its person saved it, and the new revision answers its next edit with the rule's own sentence
(part 02, section 11.3; part 03, section 5.1). What is done about such an app is yours to decide,
with the ids in hand. Where the probe refused the deploy and neither scan prints an app, the
finding comes from a rule no part expected a saved app to meet. The session stops there too and
reports the probe's counts, since naming that app takes a read of production this list does not
hold. The yes covers these reads, at both runs, and nothing that writes production.

**2. One billed check of tool definitions.** `npm run test:schema -- <name>`, once for each tool the
Solutions Architect is given whose served input schema or description differs between `main` at the
baseline and the step's head, and never the bare command, which would send every registered entry.
Each send is at most two live OpenAI requests on your key, the tool call and the answer to its
result (`scripts/test-schema.ts`, `stopWhen: isStepCount(2)`). Each request carries one tool
definition and a short prompt, asks for at most 1,024 output tokens, and goes to the model the
script defaults to (`lib/models.ts::MODEL_ROLES`, `followUpEditor`). No price was measured.

Two free comparisons of the two commits give the list, neither with a network call. The hash run
(`scripts/inspect-tool-schema-hashes.ts`) names each tool whose served input schema moved. It hashes
the input schema alone, so the session also prints each shared tool's `description`
(`lib/agent/sharedToolRegistry.ts::SHARED_TOOL_REGISTRY`) at both commits and compares them, with a
one-line `tsx` print that is never committed. The parts expect twenty-five names:

`updateModule`, `setMenuMedia`, `createForm`, `updateForm` (part 02, section 12); `addFields`,
`editField`, `setFieldOptionsSource`, `generateSchema`, `updateCaseProperty`, `setFormSections`,
`updateTranslations`, `setCaseSearchDisplay`, `addCaseListColumns`, `updateCaseListColumn`,
`configureCaseList` (part 03, section 9; the two column tools again for part 07, section 11.6);
`addCaseOperations`, `updateCaseOperation`, `addSearchInputs`, `updateSearchInput`,
`createLookupTable`, `updateLookupTable`, `editLookupColumns`, `configureConnect` (part 04, section
13); `getLookupTables`, `getOrganization` (part 11, section 12.4, each for its description alone,
which the hash run cannot see).

The two comparisons are the record: a tool they name that this list misses is sent too, and a tool
here that neither names is not. A schema the provider refuses is a defect in the schema: the session
corrects it in the tool's own file and sends that one entry again. The yes covers at most three
sends for each tool on the list, so for the twenty-five at most seventy-five sends and 150
requests. A tool still refused after three is not narrowed, hidden or left to the builder alone: the
session stops on that tool, and the step does not merge with it failing.

**3. Lane runs on GitHub's hosted runners, which the session starts itself.** They bill nothing on
this public repository (`proof/README.md`, "Seeing a reader's verdict before a merge"). Each is a
`gh workflow run` on a pushed branch, one at a time, never while a scheduled lane with the readers
is running. Part 14's section 12.4 holds each command and its cost:

- **The twenty-two bases with every reader**, in two dispatches of `proof-audit.yml`, `hq-plain` in
  both. Each is about 8 to 31 worker-hours and holds up to fourteen of the account's twenty runners
  for one to three hours. A fix that changes what a base emits dispatches that base again.
- **The new targeted documents whose parts ask a served reader's verdict**, with every reader:
  thirty-one, which are part 01's one, part 02's five, part 03's six, part 04's eight, part 11's
  one and part 15's ten. A document is about 0.7 worker-hours at the measured median and 2.6 as
  counted before a measure, so the thirty-one are about 22 to 80 worker-hours.
- **Bounded slices**, one runner each for at most 90 minutes: part 05's retained reads and the
  surface extraction, with no reader; the bases' authoring wherever a base's builder changes, with no
  reader; part 03's Android form reads, with the Android reader; part 04's CommCare Connect
  receiver, with the Connect reader; and one dispatch for the three tests that take the Web Apps
  reader, which are part 01's Run 4, part 03's search title read and part 11's two reads, the
  Android reader beside it for part 11's.

**4. The merge, and the deploy it starts.** It is neither billed nor a read of production. It is on
this list because nothing after the yes waits on a person, the merge included. Once every check of
"Checks before the merge" holds, the session merges the stack in one merge, which deploys to
production; watches the deploy until it is live or refused; runs item 1's later scans, and stops
there where one prints something or the deploy was refused over a saved app or a claim; and, once
exit check 7 holds, merges the plugin's pull request ("The plugin"). It then reads the exit's
checks: 1, 3, 4, 6, 8 and 9 from `main` and the merge commit's check-runs, and 2 and 5 from the
first scheduled night with every reader once its gate reports (part 14, section 12.2, says how
long that night runs). Where one fails, the session fixes it forward in an ordinary pull request,
merges it once its own checks pass, and reads that check again. This yes covers each such merge
and the deploy it starts.

Nothing heavy runs on your machine: no lane, no image build, and no suite run more than once for a
change. Before each push the session runs, once, what CI could fail for that change: the tests the
change reaches (`npm run test:changed`), typecheck and lint, and the Playwright smoke
(`npm run test:smoke`) where the change reaches a screen. Beside that its shell runs only what is
light: the two comparisons of item 2, the parser generator (part 04, seconds), file copies (part
14's `python3 -m proof.matrix.adopt`), part 14's `rows` print and `node proof/run.mjs --timings`
over a run's downloaded outputs (its sections 9.1 and 12.1), the plugin sweep, and the requests and
scans above.

## The parts

| Part | Plans |
|---|---|
| [01](6-bring-in/01-the-bar-and-the-manifest.md) | The admission bar made mechanical: six derived standings, `subject` and `owner` on the manifest, every row re-cut by value, the kept test and `KEPT_AT_HQ`, `TargetFacts` and its readers, the finding type, every circumstance and all finding copy |
| [02](6-bring-in/02-menus.md) | A menu that shows its forms in the menu above, and registration from the case list always offered, each a complete feature |
| [03](6-bring-in/03-questions-and-text.md) | The Phone Number question and the display vocabulary, a calculated value in text, text CommCare HQ reads as an instance, a search with no title, a sort rule's blanks, text shown as typed, a date and time saved as CommCare HQ stores it |
| [04](6-bring-in/04-names.md) | All forty-five `widen` rows decided: the name grammars built, the classes that stay not-yet, `widen` leaving the manifest's schema |
| [05](6-bring-in/05-reading-commcare-hq.md) | What the HQ client gains: the app list, the application resource, the bracketed read, form alignment, media bytes, the byte cap, one retry rule, one classification of every failed answer |
| [06](6-bring-in/06-the-reader-forms.md) | The reader's frame (`readHqApp`, the manifest at run time, the accounting cursor, findings, assembly, the declaration choices) and the whole reading of a form's source |
| [07](6-bring-in/07-the-reader-cases-menus-lists.md) | The reader of case management, menus, links, case lists and search, each rule the inverse of an emitter, and a case list column that is not on the list |
| [08](6-bring-in/08-the-reader-expressions.md) | One recognition method and its closed equivalence table, the folds, HQ's interpolation ported, record slots, search filter rows, the rewrite registry, a list of values |
| [09](6-bring-in/09-acceptance-and-the-first-publish.md) | `acceptReading` and its five checks, the canon list, the closed register of what a first publish changes, `read-back-differs` |
| [10](6-bring-in/10-identity-and-the-ledger.md) | The identity resolver, an adopted deployment's ids and media paths, one CommCare HQ app to one Nova app, the ledger at birth, ending a deployment, drift wording, the ledger migration |
| [11](6-bring-in/11-project-data.md) | Media fetched, judged and published; lookup tables and places as copies managed in CommCare HQ; a tag that meets a Project table; ownership derived from the Project's live mappings |
| [12](6-bring-in/12-the-reading-and-the-birth.md) | The two requests that read an app and create it, with nothing stored between them: the review digest, the `hq-adoption` birth in one transaction, the receipt's adoption arm |
| [13](6-bring-in/13-the-experience.md) | The three entries, the flow on `/build/new`, every screen and string, what the Publishing card and the Publish dialog say afterwards, eight MCP tools (six of its own and part 15's two), the guide, the plugin skill, the public docs |
| [14](6-bring-in/14-proof.md) | The sixth corpus source, the twenty-two bases, variants and coverage, proof 6, parity, the first-publish judge, cost and dispatches |
| [15](6-bring-in/15-changes-made-in-commcare-hq.md) | Bringing in what changed in CommCare HQ: the difference of two readings, the round trip that loses nothing, choosing a side, a replaced media file, the check when the builder opens |

## The baseline

**Nova** is read at `main` `1f103305`. Each fact below was read in the repository for this file.

- `lib/models.ts::MODEL_CONTEXT_VERSION` is `"v6-hq-round-trip-case-writes.14"`,
  `lib/db/appTests.ts::RUNTIME_VERSION` is 18, and `scripts/test-schema.ts` registers 63 entries.
- The newest migration is `lib/case-store/migrations/20261112010000_retained_conversation_sources.ts`.
- `lib/commcare/surface/entries/` holds 1,250 inventory entries: 472 HELD, 237 HELD-NEW, 26
  TARGET-OWNED, 166 INERT and 349 REFUSED. Forty-five `widen` changes sit on HELD rows. No entry
  names a noun a person reads or the step that will hold it.
- `proof/known-defects.json` is `[]`, `proof/checks/registers.py::OPEN_DEFECTS` is `{}`,
  `proof/fixed-defects.json` holds 1,017 entries and `proof/walk-stops.json` 25.
- Nothing reads an app from CommCare HQ: `lib/commcare/reader/` does not exist, and the root
  `CLAUDE.md` calls `lib/commcare` a one-way emission boundary. Every corpus document of the lane is
  a Nova document.
- `/api/commcare` is on the main host's allowlist (`lib/hostnames.ts::HOSTNAME_ALLOWLIST`), so the
  seven routes the step adds beneath it need no entry.
- `../nova-plugin` is at `0a67203`, with `.claude-plugin/plugin.json` at `2.4.2` and
  `.dev-plugin/.claude-plugin/plugin.json` at `1.31.0`.

**CommCare** is read at the commits `proof/pins.json` names, unchanged since `fe5f49a0`: commcare-hq
`d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android `7a5584475580`, commcare-connect
`046c7fd78081`, formplayer `24383ac71bfb`, and Vellum `01215f251c57`, the build HQ vendors at that
pin. Citations are `file::symbol`.

## Executed during planning

Each part's "Executed during planning" gives what it read. The findings that decided the plan:

- **HQ's own pages write values the manifest refused.** A just-created HQ app is held, inert or
  kept in every part. A real one is not, because a save in an ordinary HQ page writes values no
  author chose: `case_tile_field: ""` on every column and `blanks` on every sort row from the Case
  List page, every enabled profile setting at HQ's default from the Settings page, a blank
  `title_label` for a search with no title typed. Each of the four directories under commcare-hq's
  `corehq/apps/app_manager/static/app_manager/template_apps/` (HQ's three starter apps and an earlier
  copy of one) holds `mobile_ucr_restore_version: "1.0"` and at least two menus with `put_in_root:
  true`. Read as written, the outline's reader would have refused HQ's own starter apps, and an
  account would have been the common result. So the manifest is re-cut by value, what Nova's publish
  never writes is kept at CommCare HQ's value, and the concepts a plain app holds are built as
  complete features (part 01, sections 3 and 4; parts 02 and 03).
- **Real apps are small, and reading one is fast.** HQ's starter apps are 160,669 to 509,917 bytes
  of source (157 to 498 KiB), with 4 to 9 forms and 7 to 13 media files, and the forty app sources
  the lane retains run from about 2 to 85 KB. Nova's own parsers
  (`lib/commcare/xmlParse.ts::parseXml` and the Lezer XPath parser) take 16 ms over the largest
  starter app, with its JSON, its eleven form XML attachments and 2,379 expressions, and 31 to 38 ms
  per MiB over the three. The reader and acceptance do more than parse, so ten times that is
  allowed: about 0.35 seconds per MiB. That is why bringing an app in is two plain requests, and why
  the cap is 16 MiB: more than thirty-two times the largest starter app, and under six seconds of
  processing at that allowance, in pieces (part 05, section 3.3).
- **Three read-only production scans were run, and each found nothing**: the three of "What needs
  your yes before this starts". So no part plans a repair or the handling of a duplicate, and that
  section decides what the session does if one of them finds something later.
- **The CommCare reads at the pins**, by `rg` and reading the enclosing function, part by part. The
  claims of the research, the outline, a manifest cell or a source comment that these reads
  corrected are in
  [`harness-findings.md`](../../research/2026-09-26-hq-round-trip/harness-findings.md), "Found while
  planning step 6".

Nothing else was run: nothing in HQ, Core, Formplayer, Android, Connect, a browser or the lane, no
test, and no billed call. **Unverified until the reader exists**, each with the check that holds it:

| What | Held by |
|---|---|
| The reader's and acceptance's time at the cap, and a review's of changes | `cap.test.ts` of parts 12 and 15, in ordinary CI: each synchronous piece under five seconds. A failure is fixed in the piece that is long, and the cap stands |
| That each starter app comes in whole | `lib/commcare/reader/__tests__/bases.retained.test.ts` in ordinary CI, then the dispatches over the bases (part 08, E6; part 14, P2) |
| That reading Nova's own export gives the document back | `canonReadBack.fuzz.test.ts` (part 09) and proof 6 over the Nova-born corpus (part 14, P5) |
| That the first-publish register is closed both ways | the lane's judge over every base (part 09, section 11.3; part 14, section 9) |
| That a round trip through CommCare HQ loses nothing | `plan.fuzz.test.ts` and the ten documents of part 15 (its W2 and W3) |
| What the reader holds in memory beside a body, and how long CommCare HQ takes to answer | no test: three enforced bounds, per-call deadlines, and a log line on every answered read (part 12, "Written and not yet run") |

## What changed from the outline, and why

Items 1 to 12 are the outline's ten items, its cutover and its exit, in its order, and its Contracts
rows follow item 12. Items 13 to 15 are three decisions that span the parts, which the parts cite
here. The part named gives the evidence. What a part decides alone is in that part's "Decisions in
brief" and "Departures", and is not collected here.

1. **The reader is one pure function with admission as an accounting.**
   `lib/commcare/reader/index.ts::readHqApp` claims every key it consumes against a manifest entry,
   turns everything unclaimed into a finding, and reports every finding in one pass. Two of the
   outline's sentences are not built: an app with a translation for a runtime UI key comes in, the
   keys kept at CommCare HQ's value (part 01), and there is no stored `xmlns` slot (item 15). Parts
   05 to 09.
2. **The birth owner is `hq-adoption`, the fourth caller of the genesis writer.** Tables and places
   are written inside the genesis tail through one seam, `afterAppInsert`, and the media edges, the
   adopted deployment and the claim commit with sequence 1. Media bytes are published just before,
   as ordinary ready rows, because Project media cannot commit with an app. Parts 12, 10 and 11.
3. **Project-space data is a copy managed in CommCare HQ.** The fact lives on the Project's table
   and on the app's organization state, the writers refuse an authoring edit in one place, and a
   publish re-reads each managed table first. The ledger gains no `referenced` ownership. Part 11.
4. **The outline's drift merging becomes bringing a change in, which merges nothing.** Where Nova
   holds nothing unpublished the change is applied as ordinary mutations; where it does, the person
   chooses one side whole. A conflict view needs a rule for every pair of mutations that can touch
   one slot, and neither rule this is built on asks for one. Part 15.
5. **Entry points are three entries to one flow and eight MCP tools.** No builder exists before an
   app does, so the flow is a state of `/build/new`. The platform declaration is a preselected
   choice in the review, never a gate before the app exists. Parts 13, 12 and 15.
6. **All forty-five widenings are answered, and nine are built.** A name cannot be fixed in
   CommCare HQ without changing data, so each is built or is honestly not-yet. Names with non-ASCII
   letters are not built: each runtime reads a name by its own Unicode tables, so there is no one
   pattern to prove. `widen` then leaves the manifest's schema. Part 04.
7. **Feature-matrix apps are bases, variants and exemptions.** Twenty-two bases made through HQ's
   own pages, models and form builder; a variant is one change over a base, made in HQ and read
   where it is made; a closed exemption list. Coverage is defined, and it is not "one HQ app per
   manifest entry". Part 14.
8. **What step 3 left.** Every lowering Nova writes reads back as the arm that writes it. Where the
   outline said otherwise: `unwrap-list` is read and kept as `list(...)`, which every editor can then
   write; `call` in a record slot stays not-yet; a date-only comparison on a system date stays
   not-yet, since no read gives Nova the project space's time zone; `_xpath_query` rows are read
   conjunct by conjunct into slots Nova has. A calculated value in text is a complete feature, and
   label text holding `instance(` is a defect of today's emitter, fixed for every app. Parts 08, 07
   and 03.
9. **What step 4 left.** The reader returns each declaration the content runs on and proposes one;
   a split question reads back as three ordinary questions; the guarded and `current()` reads Nova
   writes read back as the reads they are (part 08, sections 5.3 and 5.2); media is sniffed before
   any name is trusted. **Bringing an app in asks none of the confirmations a publish asks**: the
   app already runs in its source project space, so Nova records the plan features it already uses
   and leaves the rest to the first publish. Parts 06, 08, 11 and 10.
10. **What step 5 left.** Each placement is held at CommCare HQ's real position. A Save to Case
    block is held only in Nova's own shape; one at an authored position is step 7's. An advanced
    menu's chain is built from its forms' loads. A preload reads as a default where the load's order
    allows. Links read in reverse with their held-case guards stripped. Model iteration by the
    load-time rule is not built. Parts 07 and 06.
11. **The outline's cutover is not built, because it has no data to move.** A Project table's
    standing in a project space is derived from the live mappings of the Project's apps. Part 11.
12. **The outline's exit stands as proof can hold it**: every base comes in, republishes and passes
    its proofs; every variant is refused or held as its row says; every manifest entry is exhibited
    or exempt with a reason. Part 14.

    The outline's Contracts rows are settled where their behavior is: the birth owner in part 12
    (section 6); creating afresh after an ended deployment in part 10 (section 8.7); the deployment
    record key for lookup tables, which stays one mapping for each app, with a Project table's
    standing derived from them (item 11; part 11, section 10); and, in part 11's "Contracts and
    docs these changes make false", "no arm for matched by name", which stands unchanged, and
    "every export mode carries the data", reworded for the data CommCare HQ manages.
13. **One name.** The feature's name and its verb are a rule every plan follows
    ([`README.md`](README.md), "Rules every plan follows"). In code: the reader, a reading (one read
    of one HQ app, and nothing that is kept), a finding, the account, the review, adoption.
14. **The concepts a plain app holds come in as complete features**, each across the domain, the
    validator, both emitters, Preview, the builder, the tools, the docs and proof: a menu that shows
    its forms in the menu above, registration from the case list always offered, the Phone Number
    question, a calculated value in text, a search with no title, a sort rule's blanks, text shown as
    typed, the identifier grammars, a case list column that is not on the list, and a list of values
    in a record expression. Each is something an HQ author makes in an ordinary page. Parts 02, 03,
    04, 07 and 08. Nothing else is added to the model in this step, unless a starter app shows it
    needs something more ("Checks before the merge").
15. **No `Form.xmlns` slot: identity is per adopted deployment.** An adopted app's menu ids, form
    ids, `xmlns` and media paths are ledger rows of that one deployment. Every other project space
    takes Nova's derivation. A stored slot would carry one project space's identity into every
    other. Part 10, sections 2 to 4.

**What this plan's own pull request changes.** It is docs, and one source comment. It
writes this file and its parts, rewrites [`7-rest-of-model.md`](7-rest-of-model.md), edits
[`README.md`](README.md), writes the bullets of "Found while planning step 6" in
`harness-findings.md`, and removes the outline. The comment is in
`lib/agent/authoring/printQueryExpression.ts`: it named the outline's path, and it now says the
same thing in plain words and names no plan file. So no source file cites this plan, at this pull
request or after it, and nothing in source has to change when the plan leaves. Part 08 replaces
the comment with the change that makes it false (its section 8.3 and C8).

## The order of work

The step ships as one stack and one deploy. This plan does not divide the work. It states what must
exist before what, and why; where no constraint is stated there is none.

- **The manifest's schema, the finding type and the finding copy** (part 01, sections 2, 8 and 9:
  the TARGET-OWNED arm, `subject`, `owner` and `SUBJECTS`) before every entry written in that
  schema and everything that raises or words a finding: the entries of parts 02 to 04, 06 to 08 and
  11, part 05's `hqReadCircumstance`, the reader's frame, and parts 12 and 13. The fifteen settings'
  entries parse only under the new arm, and the copy test fails on a pair with no sentence.
- **The code that makes an entry's new wording true** before that entry's flip (part 01, section
  3). A kept flip needs the `.ccz` and Preview to read the kept value, and a re-cut that claims HELD
  for something only a reader does needs that reader.
- **Every entry's own `widen` dropped** (part 01's kept flips and `xmlns` re-cut, part 02's edit and
  part 04's rows) before `widen` leaves `slotChangeSchema` (part 04, section 11.4). The schema does
  not parse an entry that still holds one.
- **Forms in the menu above** (part 02, sections 2 to 9) before registration from the case list
  (its sections 10 and 11), which refuses a host that shows its forms above, lands its return on
  `screenOfFrame` and builds its frames through `menuIdOf`.
- **The concepts the reader reads into** (parts 02, 03 and 04, and part 07's column that is not on
  the list, its 11.6) before the reader rows of parts 06, 07 and 08 that read into them, and before
  part 09's identity check. The reader writes each proposal back with the production emitter.
- **Part 05's client types, readers, `classifyHqFailure` and `HQ_BRING_IN_APP_MAX_BYTES`** before
  the reader (part 06, section 2.2), part 01's `refreshKeptValues` and build profile preflight (its
  6.5 and 7.4), part 11's reads and part 12's `gatherReading`. They are the reader's input types and
  the one classification every failed answer takes.
- **Part 05's lane edits on a pushed branch, then its slice run, then the retained
  `proof/hq-reads/reading/` files and the regenerated `surface.json`** before the Vitest suites that
  serve those files, and before `listAppBuilds` is removed. The suites replay CommCare HQ's own
  answers, which only a lane run makes.
- **Part 10's `lib/commcare/reader/identity.ts`, part 08's `pendingExpressions.ts`,
  `syntaxCompare.ts` and `hqInterpolation.ts`, and part 06's frame** (its sections 2 to 7) before
  every reader stage of parts 06 and 07. Each stage mints through the resolver, registers
  expressions as pending text and claims through the frame.
- **Part 08's `readExpressions`, `searchRows.ts` and `csqlRead.ts`, and part 11's
  `worldEntitiesFromReads` and `levelsFromHq`** before part 06's `bindExpressions` and
  `readStructure` and part 07's `settleSearches`. The structure readers settle only what a typed
  tree decides.
- **Part 08's `EMISSION_REWRITES`, whole,** before part 09's first-publish register. One assertion
  holds every `changes` id to a register id.
- **The reader, part 07's extended `publishedCaseBlocks` and `hqEntryFacts`, part 10's
  `adoption.ts` and identity functions, part 11's three pure exports and part 12's `mediaIds.ts`**
  before acceptance (part 09). Acceptance calls them, and none of them imports acceptance.
- **Part 10's `adopted` mapping and `read` baseline origin** before part 01's rules for an adopted
  deployment (its 7.2 and 7.3). The two rules read them, so they land together.
- **Identity and the ledger** (part 10) before project data (part 11), which calls
  `assignMediaPaths` and `mintingResolver` and writes `app_deployment_media_paths`.
- **The ledger migration** before the baseline's new writers: part 09's `first_publish_changes`,
  and part 15's `nova_revision`, `media_files` and the origin `changes`. Their columns are clauses
  of part 10's one migration.
- **Part 12's `afterAppInsert` seam, part 10's claim and adopted-deployment writers, and parts 06
  to 11** before part 12's `gatherReading` and the birth. The read runs them all, and the birth
  writes through them in one transaction.
- **Part 12's two routes, stream and client-safe types, part 09's `firstPublishLines`, part 10's
  ending and part 11's services** before part 13's flow, Publishing card, drift stop and tools. The
  flow draws only what a read answers.
- **The reader, acceptance, part 09's canon and its builder of first-publish facts, part 10's
  `externalIdentityMap` and its identity and media path writers, part 11's table choice, its
  managed-table services and its publication of kept files, part 12's `gatherFromHq` and its review
  types, part 01's `refreshKeptValues`, part 05's bracketed read, and part 13's card and dialog**
  before bringing changes in (part 15). A change is the difference of two readings through one
  identity map, made by the functions a bring-in runs, and shown where part 13 lays the card out.
- **`proof/corpus/left-out.json`'s first content**, read from the corpus that `main`'s CI uploaded,
  before the step's refusing rules (part 14, section 11.1), so the stop shows what those rules
  move.
- **Part 12's `gatherFromHq`, the reader, acceptance, identity, project data and part 05's reads**
  before the `hq-authored` source's bases (part 14). A base's document is the reader's answer over
  retained answers.
- **The first lane run of `proof/matrix/test_retained.py`, then `python3 -m proof.matrix.adopt`,**
  before every Vitest over `proof/hq-apps/`. Only a lane run writes what CommCare HQ made of a base.
- **`targeted-save-to-case-shapes` and its capture** before the base `hq-nova-then-builder`, which
  is authored from that document's first publish.
- **Every change to a tool the Solutions Architect is given** before the billed schema check (item
  2 of "What needs your yes before this starts"). The two comparisons at the step's head are its
  list, so a send made before a later change to that tool is paid for twice.

Three things are not constraints. The Phone Number question, a calculated value in text and text
shown as typed need nothing of one another: they write the same sites, so each is written against
the others' final form. Nothing waits for a night: the reader needs the concepts in the tree, not
deployed. And nothing needs a flag: the one deploy carries the flow with everything it stands on.

## Checks before the merge

Each part states its own checks, where each runs and what the session does for every outcome. These
rules hold for all of them:

- **Every fix lands before the merge.** There is one merge, and the stack does not merge with a
  check failing.
- **Fix Nova first.** Where a check shows Nova's emitter, reader, port or Preview wrong, that is
  corrected and the check runs again. What Nova holds narrows only where a named CommCare reader
  refuses or misreads a correctly emitted document, and the outcome names that reader.
- **No entry is added to `proof/known-defects.json`.** A difference is fixed, declared in the
  first-publish register, or held as a not-yet entry with its owner (part 14, section 11.3).
- **A control that contradicts the plan corrects the plan.** Where a fact decided by reading fails
  its control, the session corrects the code to what CommCare does, the part's sentence and the
  matching bullet of `harness-findings.md`, and goes on.
- **A starter app must come in.** Where a check shows that one of CommCare HQ's own starter apps
  needs something this step did not build, the session reads which side falls short, in this order:
  the reader misread the app; the checker refuses a record expression CommCare runs correctly; an
  entry's HELD class is too narrow for a value HQ's own pages write. Each is corrected for every
  author, with the starter as its exhibit. Where the app holds a concept Nova has no model for,
  the session builds that concept in this step, with the completeness item 14 asks of every
  concept (the domain, the validator, both emitters, Preview, the builder, the tools, the docs, the
  manifest entry and proof), and takes the concept out of its group's section of
  `7-rest-of-model.md`. It is never re-cut to not-yet and never left to an account, and no one is
  asked. This rule is the outcome of part 08's E6 and part 14's P2 for such an app, so no base
  reads to an account.

**The checks that are lane runs the session starts** are the three kinds of "What needs your yes
before this starts": the bases with every reader (part 14's P2, which also carries part 01's Run 3,
part 07's same-state readings, part 09's closed register and part 10's held media paths); the
targeted documents (part 01's Run 1, part 02's G2, part 03's six documents as the served readers
see them, its G1 among them, part 04's R2, part 11's R2, part 15's W3 and W4); and the slices (part
05's G1 to G7, part 03's G4 and G5, part 04's Connect half, part 01's Run 4, part 03's search title
read, part 11's two reads). The stack does not merge until a run over every base passes its gate,
and every other dispatch has given an outcome its part plans for and the session has done what
that outcome asks. Every other check runs in the work's own CI. Then the session merges (item 4 of
"What needs your yes before this starts").

## Migrations and the deploy

**Four ledgered migrations**, in stamp order, which is the order `migrations/index.ts` registers
them and the deploy's migration Job applies them. Each part holds its statements, its `down`, its
real Postgres test and its argument, statement by statement.

1. **`20261113000000_hq_round_trip_lookup_names`** (part 04, section 9.3). Replaces the two unnamed
   checks on `lookup_tables.tag` and `lookup_columns.wire_name` with named, wider ones.
2. **`20261201000000_hq_bring_in_ledger`** (part 10, section 11). The state `ended` and its count;
   on the mapping row, the target columns a trigger fills, the release and ending columns, and the
   partial unique index that holds one CommCare HQ app to one live Nova app; on the baseline, the
   origins `read` and `changes`, `nova_revision`, `media_files` and `first_publish_changes`; and
   the new table `app_deployment_media_paths`.
3. **`20261201010000_hq_changes_app_change_kind`** (part 15, section 4.2). Replaces the routine that
   admits an app change, adding the kind `hq-changes`.
4. **`20261202000000_hq_bring_in_project_data`** (part 11, section 6.1). Nullable columns on
   `lookup_tables`, `app_organization_state` and `app_locations` for the managed fact, with their
   checks and one partial index.

A stamp moves in one case: where `main` holds a later-stamped migration when the work is rebased,
the stamp moves to the next free hour after `main`'s newest, and the four keep their order.

**What holds for the deploy.** The four apply in one run of the migration Job and in one
transaction (`lib/case-store/CLAUDE.md`: "Kysely wraps the whole migration batch in ONE
transaction"), while `main` as it stood before the step still serves. None needs a maintenance
window. The argument has two halves, and it is made here once; each part holds its own
migration's share of it.

*What that revision writes still passes.* Each migration is additive for it: every new column is
nullable, defaulted or filled by a trigger where an older insert leaves it out; every replaced
check and routine admits every stored row and every row that revision writes; and every new check
and the new unique index hold for every row that revision writes, which part 10 argues constraint
by constraint (its section 11) and part 11 by the columns its checks read (its section 6.1).
Three statements write existing rows, all in the ledger migration and all safe to replay: one
copies a mapping's server and project space from its deployment, one releases a deleted app's
mapping that another duplicates, and one fills `nova_revision` for published baselines. Each value
they copy passes the constraint it lands under, a revision of 0 included (part 10, section 11).

*What that revision waits for is bounded.* Three of the four lock tables that revision reads and
writes. They take `ACCESS EXCLUSIVE` on `lookup_tables` and `lookup_columns` (part 04's, and part
11's on the first), on `app_deployments`, `app_deployment_resources` and
`app_deployment_baselines` (part 10's) and on `app_organization_state` and `app_locations` (part
11's), and part 10's new table takes the lock a new foreign key takes on `media_assets`, which
holds back writes of that table and none of its reads. The remaining migration, part 15's, replaces
a routine and locks no table. Because the batch is one transaction, a lock is held from the
statement that takes it until the batch commits, so the first migration's locks are held through
all four. Two bounds keep that a pause:

- *The wait for a lock.* Each of the three opens with `SET LOCAL lock_timeout = '5s'` and closes
  by setting it back to `0`. A lock request that queues behind a long reader would stall every
  later request for that table behind it, so none waits more than five seconds. One that times
  out fails the Job with nothing applied, which blocks the deploy, and running the deploy again
  tries again. Each migration's own real Postgres test holds its bound.
- *The time under the locks.* It is the statements' own work and at most five seconds for each of
  the seven tables the batch locks after the first. That work is catalog changes, one validation
  pass for each new check, three updates and the index builds, over tables that hold one row for
  each lookup table, lookup column, deployment, published resource, baseline, organization state
  and place. The one other table a statement reads is `apps`, for whether an app is in recently
  deleted. No statement reads a case, a lookup row, an app change or a blueprint entity.

While the batch holds a lock, a request of that revision that needs the table waits for the commit
and then runs. Where such a request already holds a lock the batch asks for, PostgreSQL ends one
of the two: the Job, which is run again, or the request's transaction, which
`lib/db/pg.ts::withAppTx` runs again where the request goes through it.

A migration that refuses fails the Job, which blocks the deploy with nothing applied.

**No stored document migrates, and nothing is announced.** Every
document slot the step adds is optional or a wider grammar, and no stored document holds one. No
stored case row is rewritten. The cutover the outline gave the step has no data to move (item 11).
No notice is written for any change of the step, no flag gates any of it, and no Job is planned.

**Forward only once in use.** A document saved before the deploy loads on either revision. A
rollback is not a state this plan supports: a document that uses a slot or a grammar the step adds
does not parse on the revision before it, and that revision cannot read an ended deployment or a
baseline of origin `read` or `changes`. While the rollout lasts, an instance or an open tab of the
earlier revision refuses a wider name under its own narrower schema and retries (part 04, section
9.3). A bad deploy is corrected by rolling forward.

### Versions

`lib/models.ts::MODEL_CONTEXT_VERSION` moves once, from `"v6-hq-round-trip-case-writes.14"` to
`"v7-hq-round-trip-bring-in.1"`. The step changes served tool inputs, descriptions and the guide in
many places (parts 02, 03, 04, 07, 08, 11 and 13 name each), and it is one deploy: a stored model
context is replayed only under the catalog it was made against, and only a deployed revision makes
one, so one literal separates every context made before the step from the catalog after it. A
correction before the merge keeps the literal, since no context was stored under it.
`lib/agent/CLAUDE.md` says the literal moves "in every pull request that changes" a served tool or
the guide. This step does not do that, so it rewrites the sentence to what its own reason asks:
the value differs between any two deployed builds whose served tool names, descriptions, input
schemas or guide differ, and a set of changes that merges and deploys together moves it once.
Part 13 holds the old sentence and its replacement in full, with every other place that names the
constant ("Contracts and docs these changes make false"), and exit check 8 fails while the old
sentence stands.

`lib/db/appTests.ts::RUNTIME_VERSION` moves once, from 18 to 19, for two reasons: Preview's query
repeat wrapper is renamed (part 04, section 3.4), and Preview stores a date and time saved to a case
in CommCare HQ's spelling (part 03, section 7.1). An App Test journey in flight at the deploy is
refused its next step and started again. `scripts/test-schema.ts` goes from 63 entries to 65, with
`setFormSections` (part 03) and `getOrganization` (part 11).

### The plugin

`../nova-plugin` gets one pull request, and part 13's section 16 holds it whole: the skill
`/nova:bring_in`, every edit of `upload_to_hq` with the sentences parts 01, 10, 11 and 15 give it,
both `plugin.json` versions, and why it merges only after the deploy is live. What no part holds is
the list of claims the sweep at the step's head reads the plugin's prose for beyond those edits
(part 13, section 16.3), each with the part whose change would make it false:

- that every menu has its own screen, and that registration from a case list needs a search (part
  02, section 12);
- that `{{name}}` is all a text can insert, that every text is Markdown, what a form's name or a
  CommCare Connect name may hold, and how a date and time is stored on a case (part 03, sections 5.1
  and 11);
- a name's grammar: an option value, a case type, a case property, a Search field, a lookup
  table's tag or field (part 04, section 13);
- what a publish leaves as it is in CommCare HQ, and which refusals an upload answers (part 01,
  sections 7.4 and 11);
- that a publish carries every lookup table and place an app reads (part 11, "Contracts and docs
  these changes make false");
- that a change made in CommCare HQ can only be published over (part 15, "Contracts and docs these
  changes make false").

A sentence the sweep finds false is corrected in that one pull request.

## What step 7 is left

Step 7 keeps only model Nova does not hold yet. [`7-rest-of-model.md`](7-rest-of-model.md), the
step 7 outline, holds it: the eight groups a not-yet entry names as its owner
(`lib/publish/hqFindings.ts::STEP_7_GROUPS`; part 01, section 2.3), what each group holds, in words
(a group's entries are the manifest entries whose `owner` is its id; part 01, Appendix A.1), a
default order that nothing in step 6 measures or decides, and five features that are not planned,
a second project space for one app among them. None of the five is a deferral of this step.

## Exit

Step 6 is done when each check below holds after the merge, read from `main`, the merge commit's
check-runs and the first scheduled night. The session reads each (item 4 of "What needs your yes
before this starts"). A check that fails is fixed forward and read again, never by a register
entry.

1. **Nothing passed by being registered.** `proof/known-defects.json` is `[]`, `OPEN_DEFECTS` is
   `{}`, no fixed entry left its control, and no register entry names `proof6`, `parity`, `source`
   or `changes` (`proof/checks/test_registers.py`, and the night's register gate).
2. **Proofs 1 to 6 pass on every corpus document, with every reader**, and parity holds wherever
   Python decides: the lane on the merge commit, and the first scheduled night.
3. **Every base comes in, republishes and passes its proofs; every variant reads as its row says;
   every manifest entry is base-exhibited, variant-exhibited or exempt with a reason.** The bases'
   groups in the lane, and the coverage test of part 14's section 7.
4. **The first-publish register is closed both ways**: on every base the predicted ids equal the
   observed ones (part 14, section 9).
5. **A round trip through CommCare HQ loses nothing**: part 15's ten documents hold what each
   states in the night: the eight that state `brings-in` their five checks, and the two that state
   `proceeds` that outcome.
6. **The manifest states no widen**: `rg -n '"direction": "widen"' lib/commcare/surface/entries`
   prints nothing (forty-five lines at the baseline).
7. **The deploy is live**, its migration Job applied the four migrations, and the runtime probe
   refused no saved app: every check-run of the merge commit concludes `success`, listed first with
   `gh api repos/{owner}/{repo}/commits/<sha>/check-runs`. An empty list is an error to look into.
   And the registration scan and the instance text scan, run once the deploy was live, printed
   nothing (item 1 of "What needs your yes before this starts").
8. **The contracts, the docs and the source say what is so.** The first, second and fourth commands
   below print nothing, and the third prints only the four lines that keep the word for something
   else: records from elsewhere (`building-with-nova.mdx`), a CSV that replaces a table's rows
   (`project-data.mdx`) and the CommCare HQ app file (`project-space-compatibility.mdx`,
   `publishing.mdx`). The fourth holds at every commit from this plan's own pull request on: no
   source file names a plan file of this step.
9. **Nothing one-off is left, and the plan has left.** `git ls-files scripts` lists none of the three
   scans; `docs/plans/hq-round-trip/` holds `README.md` and `7-rest-of-model.md`; the plugin's pull
   request is merged.

```
git ls-files -z -- '*CLAUDE.md' docs/architecture docs/testing.md content/docs design proof/README.md \
  | xargs -0 rg -n -U -e '6-import' -e '6-bring-in' -e 'listAppBuilds' -e 'resolveUploadDomain' \
  -e 'caseListRegistrationFormOf' -e 'caseListFormReturnFrame\b' -e 'proof/corpus/hq\b' \
  -e '[Oo]ne-way\s+(CommCare\s+|`lib/commcare`\s+)?emission' -e 'emission\s+boundary\s+is\s+one-way' \
  -e 'explicit-blank\s+\|\s+design-slice`' -e 'All\s+three\s+use\s+one\s+genesis\s+writer' \
  -e 'Both\s+ways\s+an\s+app\s+is\s+born' -e 'the\s+three\s+edges\s+that\s+TALK' \
  -e '[Pp]roofs\s+1\s+to\s+5' -e 'Five\s+sources' -e 'without\s+the\s+hyphen' -e 'quotes\s+dropped' \
  -e 'at\s+least\s+two\s+((fully\s+)?UUID-identified\s+)?options' \
  -e 'moves\s+in\s+every\s+pull\s+request'

rg -n -U -e '[Oo]ne-way\s+(CommCare\s+|`lib/commcare`\s+)?emission' \
  -e 'emission\s+boundary\s+is\s+one-way' lib app components proof scripts biome.json

rg -n -w -i -e 'imported|importing' content/docs

rg -n -e '6-import' -e '6-bring-in' lib app components proof scripts
```

Run at the baseline, the first command finds seventeen of its patterns in fourteen files, the
second nine lines (four messages of `biome.json`'s rule, two source comments, three contract
sentences), the third six, and the fourth one: the comment of
`lib/agent/authoring/printQueryExpression.ts`, which named the outline's path there. This plan's
own pull request rewords that comment to name no plan file, so from that pull request on the
fourth command prints nothing. The first command's last pattern is the sentence of
`lib/agent/CLAUDE.md` that moves `MODEL_CONTEXT_VERSION` "in every pull request", which part 13
rewrites. Each other hit is a sentence a part rewrites under "Contracts and docs these changes
make false", so silence after the step is evidence. A hit is fixed in the file that part names.

**When the step ships, this plan leaves `docs/plans/`**, in the stack that ships it, as the
repository's rule for a finished plan says. `6-bring-in.md` and `6-bring-in/` are removed. The
README's row for step 6 reads done, with a section "Step 6 is done" written as "Step 5 is done" is:
what the step made true, then where what endures lives, one bullet for each file the parts name
under "Contracts and docs these changes make false". The README's other links to this plan lose
their link and keep their words. `7-rest-of-model.md` is not edited: it links to no file of the
plan, and from then its "part NN" means that part as it stood in the last commit of `main` that
holds it (its second paragraph). What endures lives in the files each part names under "Contracts
and docs these changes make false": the subtree `CLAUDE.md` files, `docs/architecture/`, `design/`
and the public docs.
