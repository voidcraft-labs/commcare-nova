# Step 7: The rest of the model (outline)

Step 7 is what is left when step 6 exits: bringing in what someone changed in CommCare HQ after Nova
last read their app, every concept an HQ app can hold that Nova's model does not hold yet, and updating
a copy of an app that already lives in a second project space. Each group below is its own step for the
cutover rule, planned in full when the group before it exits, against the code as it then stands. This
file is written with step 6's plan ([`6-bring-in.md`](6-bring-in.md), its parts in
[`6-bring-in/`](6-bring-in/)), and "part NN" below is a part of that plan, named with the pull request
(A1 to A11, B1 to B15) that lands what is cited. B15 removes that plan from the tree. In the same pull
request it takes the two links above out of this file and re-points every citation below at the file
and heading that then hold what was cited, by the rule and the tables of part 15's section 16 ("How
`7-rest-of-model.md` is re-pointed" for a section, a Departure, a run or a row; "Where each enduring
contract lives after" for a part cited whole), so no citation here outlives what it cites.

CommCare facts here are read at step 6's pins: commcare-hq `d6c6e16d8ae1`, commcare-core
`8e9ba8d908e9`, commcare-android `7a5584475580`, commcare-connect `046c7fd78081`, formplayer
`24383ac71bfb` and Vellum `01215f251c57`. A group's full plan reads each fact again at the pins that
stand when it is written.

## What changed from the outline this replaces

The outline this replaces was a catch-all: eight groups in the order of the inventory's HELD-NEW concept
list ([`inventory/README.md`](../../research/2026-09-26-hq-round-trip/inventory/README.md)), less what
steps 2 to 6 built. Five things changed.

- **The order is measured.** After the first group, the next group to plan is the one the census of
  readings says brings the most apps in soonest ("The census, and the order", below). The order this
  file lists the groups in stands only where the census does not decide.
- **The first group is new.** Bringing HQ's later changes in was item 4 of step 6's outline, "Drift
  merging". Step 6 keeps the stop, words it by where the baseline came from and puts "Stop publishing
  here" beside "Publish over this"; the merge is group 1 here, built on the reader, the identity rows
  and the baselines step 6 lands.
- **The groups are cut by what one page of CommCare HQ writes**, so each group makes whole apps come in,
  and each has an id the manifest holds. From step 6 every HELD-NEW entry names its `owner`, one of
  `lib/publish/hqFindings.ts::STEP_7_GROUPS` (part 01, section 2.3, A2), and the manifest test fails an
  entry without one. The entry lists below are the manifest's own, as it stands when step 6 exits:
  nothing here assigns an entry a second time.
- **Step 6 took concepts out of the old list**, because plain apps and HQ's starter apps hold them:
  forms shown in the menu above their own, registration from the case list always offered, the Phone
  Number question, a calculated value in prose, a search with no title, a sort rule's blanks first or
  last, a form whose text formatting is off, a search's filter rows read as one conjunction, the
  settings kept at CommCare HQ's value, and media at the path CommCare HQ holds it. "What step 6
  settled of the old outline", near the end, names each with its part.
- **The last group is new.** Updating a copy of an app in a second project space is something Nova does,
  not content an app holds. Step 6 says plainly that it cannot yet (part 13, the review's sentence V21c
  and the publish dialog's D7, B11).

## The census, and the order

Every reading of an HQ app stores a census: for each finding the read met, its code (a manifest entry id
or a circumstance), its standing, its owner group and a count (`hq_app_readings.census`,
`lib/deployment/reading/census.ts::censusOf`; part 12, section 8.1, B10). A census holds entry ids,
standings, group ids and numbers, and nothing an app's author typed. It is written with every account,
every stop and every readable app, and it survives Remove.

It is read by `scripts/inspect-hq-readings.ts` (part 12, section 8.2, B10), a read-only inspector that
takes `--prod` as the other inspectors do. It takes the latest reading of each app a person read and
prints three tables. The first, "By step 7 group", gives for each group id the number of apps with at
least one not-yet finding of that group, and the number of apps for which that group is the only thing
between them and coming in. **The second column is the order of the groups after the first**: the group
with the most such apps is planned next, a tie goes to the group with more apps in the first column,
and a tie on both goes to the group listed first in "The groups, and the order" at the end of this
file. The script stays after step 6 and runs again whenever a group is planned, so a group that exits
re-sorts what is left. Its output is execution evidence: it prints no app, project space, Project or
person, and it is never committed, so this file and a group's full plan carry the order and never a
count.

Where the census does not decide, the order is the one that closing table lists: when no reading holds
a not-yet finding yet, and when the person does not run the inspector (part 15's run H8, outcomes B and
C). The census is read again before each group is planned, so the listed order holds only until a
reading says otherwise. The pull request that plans a group writes the order it found into that table.

Two groups stand outside the census. `changes-made-in-hq` is first by step 6's plan: a team that brings
an app in and keeps working in CommCare HQ needs it the day after. `second-project-space` is last: no
reading meets it, since a reading reads one app in one project space once, so no census counts it, and
it builds on group 1's comparison of two readings.

Two groups share one piece of work, and the census decides which builds it: names with letters outside
ASCII (a case property in a case write, `forms-and-case-management`; a lookup table's tag or field,
`project-data-at-hq-size`) need one name token and one table of the characters every declared platform
reads, generated and proven on both, with a reference text that admits them. The one of the two the
census puts first builds the token and its table, and the other reuses it (part 04, section 2.3, A9).

## What every group lands with

A group holds a concept the way step 6's stack A does: as a complete Nova feature (domain, validator,
emitter, Preview, builder, Solutions Architect and MCP, public docs, platform row, proof), and from step
6 with its reading too. The rules below bind every group.

- **The reader reads it in the pull request that emits it.** The bar of step 6 holds: the reader admits
  exactly what the gate admits, and re-reading Nova's own emission of a document gives `canonDocument`
  of that document (proof 6; part 09, section 9, B7; part 14, section 5, B13). An entry flips to HELD in
  the pull request whose emitter and reader first make its wording true, with its inventory row, and
  there it loses `subject`, which only a HELD-NEW or REFUSED entry holds, and `owner`, which only a
  HELD-NEW entry holds (part 01, sections 2.2, 2.3 and 2.6, A2). Its claim joins the reader's claim
  tables, which a test binds to the manifest (part 06, B2), and a use Python decides gets its
  value-class reader for parity (part 14, section 8, B13).
- **A stored account learns of it by itself.** A reading stores the manifest revision and the entry ids
  it met, so a row on the home list says "Nova can now hold everything this list named" with no read of
  CommCare HQ once every entry it named is held (part 12, B10; part 13, B11). A group writes no
  announcement and no notice for this.
- **Platform rows.** From step 4 every HELD entry read per platform whose readings differ belongs to a
  feature of the platform table (`lib/domain/platforms.ts::PLATFORM_FEATURES`, its entries in
  `lib/commcare/surface/platformFeatureEntries.ts`) or to its ambient list (`AMBIENT_PLATFORM_ENTRIES`,
  an entry no author choice reaches, with its reason), held by
  `lib/commcare/surface/__tests__/platformFeatures.test.ts`, and each of its cells that reads neither
  `runs` nor `not-applicable` has a row in Preview's cell table
  (`lib/preview/__tests__/platformCells.ts`, held by `platformCells.test.ts`). So a group that flips an
  entry with such a reading adds its feature row and its Preview cells in the same pull request, or CI
  fails. A feature that reads `unavailable` on a platform also carries its refusal copy, a fixture in
  `lib/domain/__tests__/platformFeatureFixtures.ts`, its builder offering disabled with
  `platformPickerLine`, and a cause word in `lib/notices/migrationNoticeCopy.ts::PLATFORM_CAUSE_WORDS`,
  whose test holds the record to every feature that reads `unavailable`. A new or changed row changes
  the guide's generated platform sentences, so it moves `MODEL_CONTEXT_VERSION`. An ambient entry whose
  concept a group makes an author's choice leaves the ambient list for a feature, since its reason no
  longer holds.
- **What a first publish changes shrinks.** Where a group holds exactly what step 6 could only declare,
  the entry of `FIRST_PUBLISH_CHANGES` and its emission rewrite leave in the same pull request (part 09,
  B7), and the lane's register file with them (part 14, section 9, B13). Four entries of part 09's
  section 11.2 are named below with the group that retires them: `detail-only-columns-searched` (row
  18, group 5), `search-today-device-day` (row 12, group 7), and `search-filter-joined-to-list` and
  `search-restates-list-filter` (rows 17 and 19, group 7). One stays through its group:
  `sort-rule-kept-as-hidden-column` (row 15) changes no behavior, and a sort rule is the `sort` slot
  of its column (part 10, section 2.2), so group 5 holds a sort's label on the hidden column that
  entry keeps; the entry leaves only if that group's plan gives a sort rule a place apart from any
  column. A group's full plan reads section 11.2 whole and names every other entry its concepts make
  exact.
- **Coverage.** Every manifest entry is in exactly one of the lane's sets (base-exhibited,
  variant-exhibited, exempt; part 14, section 7.5, B13). An entry a group holds moves from its variant
  to a base: an HQ-authored app that holds it comes in, republishes, and passes every proof.
- **One cutover per group, only where a stored shape moves.** Step 6 migrates no document. A group whose
  concepts are optional slots or wider grammars migrates none either; a group that changes a stored
  shape follows the cutover rule of [`README.md`](README.md), with its scan first.

**Exit, for every model group.** No HELD-NEW entry names the group as its `owner`. Each entry it owned
is HELD and exhibited by a base that comes in, republishes and passes proofs 1 to 6, or the group's full
plan re-cut it to another standing with the evidence at source. No circumstance of
`lib/publish/hqFindings.ts::CIRCUMSTANCE_STANDINGS` carries the group as its owner, or the group's full
plan keeps one with its reason (part 01, section 8.3). Neither condition waits on a person: once no
entry and no circumstance names the group, no reading can raise a not-yet finding of it. Each group
below adds what is its own.

## The manifest step 7 starts from

At `15a00a97` the manifest holds 237 HELD-NEW entries. Step 6 moves 20 of them out (twelve to HELD,
seven to kept at CommCare HQ's value and one to inert; part 01, section 3.8) and adds 69 (66 new entries
and three re-cuts of entries that are HELD or REFUSED today; part 01, Appendix A.1, "Joining, by pull
request"). **Step 7 starts from 286 HELD-NEW entries**, each with one owner:

| Group | Entries |
|---|---|
| `question-display` | 64 |
| `case-list-and-detail` | 62 |
| `case-search` | 42 |
| `xform` | 39 |
| `forms-and-case-management` | 33 |
| `menus` | 23 |
| `project-data-at-hq-size` | 13 |
| `settings-nova-comes-to-own` | 10 |
| `changes-made-in-hq`, `second-project-space` | none |

The counts are for every gated run of step 6 giving the outcome its part plans for. They move by a few
where a run gives another outcome: part 02's run G6 (outcome B leaves out the two entries about a first
menu that shares one case, both `menus`), its run G3 (outcome C adds one, `menus`), part 07's run G2
(outcome B adds `case-search/excluded-prompt-no-filter-reads`), a fallback row of part 04's run R2
(owners `xform`, `menus`, `project-data-at-hq-size`, `forms-and-case-management`), a difference part
01's Run 1 finds that no kept row names (`settings-nova-comes-to-own`), and outcome C2 of part 14's P1
and P2. Each such entry lands with its `owner`, so the manifest is the list, and the lists below follow
it.

In the lists below a line gives a subject in the words a person reads, its slug and count, then the
entries. Where every entry of a line is in one area the area is written once. An entry followed by a
pull request id in parentheses is one step 6 adds or re-cuts there.

## 1. Changes made in CommCare HQ (`changes-made-in-hq`)

**The experience.** A person publishes, and Nova finds the app in CommCare HQ is not what it last knew.
From step 6 the publish stops before anything is sent and lists what changed by menu and form
(`lib/deployment/remoteChanges.ts::describeAppChange`), in words that are true of where the baseline
came from ("since Nova brought it in on" a date, or since Nova last published; part 10, section 9, B8).
There are three ways on, all on one screen and none chosen for the person: tick "Publish over this" on
each change, "Stop publishing here" (an owner or admin of the Project; part 10, section 8, and part 13,
section 11.3), or close the dialog and publish later. A save in CommCare HQ that changed no value stops
the publish too. From this group the person can bring those changes in to Nova, a save that changed
nothing stops no one, and Nova can say that CommCare HQ's copy has moved before anyone presses Publish.
It serves every app Nova publishes, born in Nova or brought in.

The design below is the one step 6's plan hands this group, and it follows the research's "Living with
HQ after import". Step 6's product names none of it: its docs say bringing the changes in comes later.

**What is read.** Two sources of one deployment, both through step 6's reader
(`lib/commcare/reader/index.ts::readHqApp`; parts 06 to 08, B2 to B6): the source the deployment's
baseline stores, and CommCare HQ's app now, read with the publisher's own key through
`readHqAppForReading` (part 05, B1). The second reading has every input a reading has. The first has
the stored source alone, and question 12 below decides what stands in for the rest: the reader also
takes each form's real id and CommCare HQ's question summary (`ReaderInput.modules`), the tables, the
levels and the media index (part 06, section 2.2), and a baseline stores none of them
(`lib/deployment/hqSourceBaseline.ts::normalizeHqAppSource` keeps the source with each form id
replaced by its position). Both readings pass through the same reader, so whatever the reader
normalizes cancels, and the two are compared with the functions acceptance and proof 6 already use:
`readBackDifferences` over `canonDocument`, with `canonicalExpression` for a slot's spelling and
`generatedDifference` for the nodes Nova's emission adds (part 08, B6; part 09, section 9 and 11.1, B7).
From this group, drift is the difference of the two readings wherever both read. A save that changed no
meaning is then no change: the publish proceeds and nothing is asked.

**How a change is matched to a Nova entity.** From step 6 every baseline that holds a source holds its
identity map, the map from external key to Nova UUID of the document that source describes
(`app_deployment_baselines.identity_map_gzip`, bound to its source by `identity_map_source_digest`;
written at an adoption from the keys the reader claimed and at every publish by `externalIdentityMap`;
part 10, sections 2.5 and 10, B8). This group is its first production reader:
`lib/deployment/store.ts::readAppBaselineIdentityMap`, handed to
`lib/commcare/reader/identity.ts::matchingResolver`, which answers a key the map holds with its UUID and
mints UUIDv5 over the app's id for the rest. So both readings carry the live document's UUIDs wherever
the live document holds that entity, and what CommCare HQ added gets the UUID a fresh reading would give
it. The map is stored because it cannot be computed later: an entity made in Nova has a random UUID no
key derives, and the document at a pushed revision is not reconstructible behind a fold horizon. The
deployment's identity rows (`app_deployment_identities`: each menu's and form's HQ id and `xmlns` on
that project space) and its media paths (`app_deployment_media_paths`) say where each entity lives in
CommCare HQ, and a bring-in writes the rows of what HQ added.

The keys are part 10's (section 2.2): a menu by its `unique_id`, a form by its `xmlns`, a question by
its path, an option by its value, a Search field by its name, and a column, a case operation and a link
by content and an ordinal among equals. Where a key changes in CommCare HQ the entity reads as one
removed and one added. That is how a rename in CommCare HQ arrives, and the review says so: a question
renamed there is a new question to CommCare HQ's own data too, and no diff synthesizes a case property
rename.

**The three-way comparison.** Base is the reading of the baseline, theirs the reading of CommCare HQ
now, and ours the live document. CommCare HQ's change is
`lib/doc/diffDocsToMutations.ts::diffDocsToMutations(base, theirs)`, ordinary Nova mutations. Nova's
change is the same diff of base against `canonDocument` of the live document, with both sides less what
no reading holds. A reading of Nova's own emission gives `canonDocument` of the document and never the
document (part 09, section 9), and it holds no user type, persona or automation
(`lib/commcare/reader/identity.ts::KINDS_WITH_NO_EXTERNAL_KEY`; part 10, section 2.2) and no
`appSettings.runsOnlyOn`, so the comparison leaves out exactly what `readBackDifferences` leaves out
(part 09, section 9.1). Compared raw, every spelling the reader returns another member of and every
persona would read as a change Nova made, and an app holding either would never read as unchanged.

One delta the diff does not give as written. `diffDocsToMutations` with no recorded provenance throws
`CasePropertySemanticProvenanceRequiredError` where
`lib/doc/casePropertyRenames.ts::isCasePropertyRenameShapedEndpointDelta` holds: a case type whose
property name differs at one catalog position, in a way a rename would plan. A question renamed in
CommCare HQ that saves to a new property can give exactly that between base and theirs, and a
`renameCaseProperties` Nova committed since the baseline gives it between base and ours. Question 11
below decides how each side is built.

- *Nova has not changed since the baseline.* CommCare HQ's change applies to the live document whole,
  with no merge and no question. What no reading holds (personas, user types, automations, the
  platform declaration) stays as it is, and every unchanged entity keeps its UUID.
- *What merges cleanly.* A mutation from CommCare HQ's side whose target Nova's side did not change
  applies as it is: a question added, a label reworded, a column reordered, a form or a menu added.
- *What conflicts.* A mutation whose target both sides changed. The person decides each one, in one
  question with two answers, Nova's or CommCare HQ's, worded as what a worker would see ("You changed
  this in Nova, and it changed in CommCare HQ" is the working sentence). There is no merge tool: what
  merged cleanly is listed in Nova's words, by place, and asks nothing; only a conflict asks; one act
  brings it all in.
- *The whole batch passes the commit gate or nothing is committed.* A gate finding is shown against the
  change that caused it, and keeping Nova's side of that change is always a way through. An app is never
  left half merged: CommCare HQ's app at a moment is one document, and the answer is bound to the digest
  of the source the person reviewed, as a confirmed discard is today
  (`app_deployment_baselines.discarded_digest`).
- *The commit* is one batch of a new mutation-bearing `app_changes` kind the server writes, admitted as
  `publish-placement` is (an additive migration replaces `nova_admit_app_change_insert`), with the
  authority a publish has to record placement holds
  (`lib/db/placementAuthority.ts::placementChangeRefusal`), since what CommCare HQ holds is the fact
  those holds record. It reaches open builders as any server commit does.

**A change Nova cannot hold.** Where CommCare HQ's app now reads to an account, nothing is brought in: a
partial app that publishes back deletes what it did not hold. The stop shows the account, with step 6's
findings, standings and copy (part 01, sections 8 and 9), and says that publishing over these removes
them from CommCare HQ. The ways on are the three the person has today, each still unticked and the
person's own: publish over it, stop publishing here, or, for a finding that is something to change in
CommCare HQ, change it there. A menu that mirrors another, added in CommCare HQ after Nova last read the
app, is the worked case: step 6 refuses that publish (part 05, section 7, B1), and from this group it is
a not-yet line of the account under `menus`, until that group holds mirror menus. A baseline with no
source (`unread`), or one whose source does not read under the reader, gives no base reading. What
this group offers such a deployment is open, and question 13 below states what is known on each
side; until its plan decides, it offers what it offers today: publishing over, or stopping.

**A hint before publish.** Each app mapping records the revision of CommCare HQ's app Nova last saw
(`remote_revision`, set from the reading at an adoption). Opening the builder with a key that reaches a
deployment's project space reads the app's current version once, in the background, with the person's
own key, and where it has moved a chip in the header says so. Step 6 builds neither the chip nor the
check (part 13, Departure 12, B11).

**Lookup tables and places.** A table managed in CommCare HQ needs nothing new: step 6 re-reads it
before a publish with the publisher's key, a change to its rows refreshes Nova's copy with no stop, and
a change to what the app reads stops with the next step said (part 11, section 8.1, B9). A table Nova
manages is the other case. From step 6 its drift stop offers publishing over CommCare HQ's change, and
for a table that came from CommCare HQ the item names a second way that lives on the table's page, "Let
CommCare HQ manage it again" (part 11, section 9). This group adds the second answer at the stop itself:
use CommCare HQ's rows, which replaces the Project's rows through `lib/lookup`'s existing replacement
and names the apps that read the table. It is a replacement of one table, never a merge of rows. Places
are a copy managed in CommCare HQ and read-only in Organization, with no "Manage in Nova" (part 11,
section 11.4); taking an organization over is this group's, with the merge that makes it safe.

**What step 6 builds toward it.** The reader and its accounting (B2 to B6). Acceptance and the one
read-back comparison (`acceptReading`, `readBackDifferences`, `canonDocument`; part 09, B7). The
resolver and the key table with `HQ_ENTITY_KEY_VERSION` (part 10, sections 2.1 to 2.3, B2). The
identity map on every baseline, the `read` baseline origin, drift wording by origin and the ended
deployment (part 10, B8). Managed tables and places with their refresh (part 11, B9). The findings, the
account and its copy (part 01, A2; part 13, B11). Proof 6 and the reader as a lane bundle (part 14,
B13), which exports what the merge's lane needs: `readForLane`, `LaneReadInput`, `LaneReading`,
`withRetainedHq`, `RetainedHqPeer`, `LANE_TARGET`, `mintLaneLookupIds` and `mintLaneMediaId`
(`proof/reader/`).

**What its full plan decides.** Each is open: step 6's plan decides none of them.

1. Does the baseline move in the bring-in's transaction (it becomes CommCare HQ's source with origin
   `read` and the new identity map, so the publish that follows starts from a baseline equal to HQ), or
   stay until the next push, with the brought-in digest recorded as a discarded one is? Step 6's
   plan chooses neither. Part 01's refresh of kept values rewrites a baseline only
   where nothing Nova writes changed, and the kept list's date follows whichever is chosen.
2. What is a conflict's grain: the same slot of an entity, or the same entity? And how is "Nova changed
   it" computed? Known: the document at a pushed revision is not reconstructible behind a fold horizon,
   which is the reason the identity map is stored, so the base reading and the live document are always
   both at hand and a replay of `app_changes` is not. Their diff is the one "The three-way comparison"
   states, less the delta question 11 covers.
3. What tells "Nova has not changed"? Known: the app mapping records `pushed_revision`, 1 at an
   adoption's birth. Open: which server-written rows after a push (a `publish-placement` change) count
   as no change.
4. What is offered a deployment whose baseline holds a source and no identity map? Known: a baseline
   written before step 6 holds none, its next publish under step 6 stores one, and step 6 reads no map
   in production (part 10, section 10). And a change to any key of part 10's table mints a new
   `HQ_ENTITY_KEY_VERSION`, which stored maps of the old version must be translated to or read beside.
5. What does the comparison of two readings not see that step 2's comparison of two sources does (a form
   id that changed under an unchanged `xmlns`, a key Nova keeps at CommCare HQ's value), and does step
   2's comparison stay beside it for those?
6. The new change kind's name (`hq-bring-in` is the working name), and whether undo crosses it.
7. Does the app's version in CommCare HQ move by exactly the saves one Nova publish makes, so the hint
   compares against the version read back after the publish? Known: step 6 brackets a reading by the
   application resource's version before and `current_app_version` after (part 05, B1).
8. A change that brings a media file, or reads a lookup table the Project does not hold: are the bytes
   and the table fetched as a reading fetches them (part 11's media and table functions; part 12's
   steps), inside the stop?
9. What a merge of places is, for taking an organization over.
10. Every sentence of the review, held to `design/readme.md`. The working words ("Bring this in", "Use
    CommCare HQ's version", "Keep Nova's", "CommCare HQ's copy now has something Nova can't hold yet.
    Publishing over it removes these from CommCare HQ.") are a start and bind nothing.
11. A delta shaped like a case property rename. Known: `diffDocsToMutations` refuses one with no
    recorded provenance (`CasePropertySemanticProvenanceRequiredError`), and the one provenance it takes
    for a delta that is no rename, `recordedNonRenameForward`, is an admitted batch whose replay gives
    the endpoint, which two readings do not have. A change read from CommCare HQ never moves saved
    rows: a Nova rename moves the Project's case rows from one property to the other, and nothing in
    two sources says a person meant that, which is the refusal's own reason ("Endpoint snapshots
    cannot decide whether saved rows should move"). A rename Nova made since the baseline is a recorded
    command in `app_changes`, which may lie behind a fold horizon. Open: how the bring-in builds
    CommCare HQ's side as a removed property and an added one without that refusal (a diff of its own
    over the two readings, or a provenance arm the kernel admits for a reading), and how Nova's side is
    computed across a rename Nova made.
12. What the base reading is handed. Known: `ReaderInput` takes `modules`, `lookup`, `organization` and
    `media` beside the source (part 06, section 2.2), and a baseline stores the normalized source alone,
    each form id replaced by its position (`normalizeHqAppSource`). Open: whether a baseline comes to
    store the alignment and the project data its reading took (an additive column, written at an
    adoption and at every publish from the read the publish already makes), or the base reading builds
    its alignment from the stored source and takes the Project's tables, places and media as they stand.
    The first holds for baselines written after it ships; a baseline written before it needs the second
    or is offered what question 4 offers a baseline with no map.
13. What is offered a deployment whose baseline is `unread`, or holds a source the reader cannot
    read. Known, for offering no bring-in at all: with no base reading there is no three-way
    comparison, so nothing says which of Nova and CommCare HQ changed a thing, and today such a
    deployment is offered publishing over or stopping and nothing else. Known, for offering one:
    step 5 already says what such a deployment's document holds. A published deployment whose
    baseline Nova could not read keeps the placement of each case change and query repeat, held, and
    a query repeat whose rule gives the count placement is the one exception and takes it
    (`lib/deployment/CLAUDE.md`, "Baselines", `placements-kept-unread`), so a bring-in over it would
    start from that rule and could not move a held placement. Open: whether this group offers such
    a deployment nothing new, or a bring-in with no base, in which every difference between the live
    document and CommCare HQ's app is a conflict the person settles and placements follow step 5's
    rule. The two cannot both hold, and this file chooses neither.

**Proof.** The lane already states what a person saves in CommCare HQ over a published app
(`hq-side.json`, each save made by `proof/observe/hqside.py` through the HQ view a person's page
reaches): UI translations, settings, add-ons, a build profile, a lookup table kept with content Nova
does not write. Each such document says what Nova's next publish does: it `proceeds`, `discards` after a
confirmation, or `stops`. None of them is a change to a form, a menu or a case list. This group extends
`hq-side.json` with content edits (a person's change to a form, a menu or a case list, made through the
HQ page that makes it) and a fourth outcome, `merges`, with the document the merge must give. Part 14
leaves `HqSideSaves` as it is and plans none of this (its Departure 8).

**Exit.** For each kind of content edit `hq-side.json` can make, a document whose edit is brought in and
republished: CommCare HQ then holds both sides' work, and proof 6 reads the merged document back as a
fixed point. A save that changes no value stops no publish. An edit Nova cannot hold reaches the account
with the standing its entry gives. On the `hq-side.json` document that saves a lookup table, the lookup
stop's second answer replaces the Project's rows with CommCare HQ's and names the apps that read the
table. The header chip shows for a document CommCare HQ saved after Nova's publish and stays away for
one it left alone. A deployment whose baseline holds no identity map is offered what question 4
decides, on a document whose baseline is written without one. No entry of the manifest moves.

## 2. Project data at CommCare HQ's size (`project-data-at-hq-size`)

Lookup tables, places and media as large and as rich as a project space holds them.

**Concepts.** What a lookup table holds beyond one text value a field: field properties and cells of
several values, row attributes, rows that go only to their owners (a table that is not global), an
indexed field, the two cell states a device tells apart, and a table tagged `types`. Choices and Search
field choices read from a row's attributes or a field's properties. A tag or a field name with a letter
outside ASCII, with a period, or equal to an instance name CommCare owns. Sizes: a table over Nova's
caps (`lib/lookup/constants.ts`) or the tables of one app over what one `.ccz` carries
(`lib/commcare/lookup/fixtures.ts`: 10,000 rows, 100,000 values, 16 MiB), a media file over 5, 10 or 50
MB by kind, and an app over 500 files or 200 MB.

**Entries (13).**

- *A lookup table* (`lookup-tables`, 10), `expressions-and-data/`: `tag-types`,
  `fields-properties-and-multi-valued-cells-name-lang-en-name-name`,
  `item-attributes-and-per-row-attribute-values`, `is-global-false-row-owners-user-group-location`,
  `fields-is-indexed`, `absent-field-vs-zero-values-vs-empty-string`,
  `table-or-row-count-beyond-nova-s-caps-5-000-rows-250-columns-64`,
  `tag-or-field-name-with-non-ascii-letters` (A9), `tag-equal-to-an-instance-name-commcare-owns` (A9),
  `tag-or-field-name-holding-a-period` (A9)
- *A media file* (`media-files`, 1), `expressions-and-data/`:
  `an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app`
- *A question's choices* (`question-choices`, 1), `questions/`:
  `itemset-refs-to-attr-or-property-qualified-fields`
- *A search field* (`search-fields`, 1), `case-search/`:
  `itemset-refs-to-item-attributes-attr-or-property-qualified`

Four circumstances carry this owner and no entry, each a fact of a project space's data that no manifest
entry names (part 01, section 8.3): `too-large` (the app's source over the read's bound, or a check or a
birth longer than one of Nova's steps), `places-over-nova-limit` (more active places than the 10,000
Nova holds for an app), `place-not-holdable` (a level's code, a place's site code, name, coordinates,
parent or value outside what Organization holds) and `owner-rule-needs-one-place` (part 11, sections
11.2, 11.4 and 13.2, B9). The group's exit counts them with its entries.

**What step 6 builds toward it.** Only the tables an app reads come in, each a copy managed in CommCare
HQ, every column text and every cell CommCare HQ's string as it stands; the managed fact lives on the
Project table; a publish to another project space creates the table from the copy (part 11, sections 5
to 9, B9). The findings above are raised from the reading, never as a gate refusal after the birth
(`lookupTableFindings`, `lookupFixtureBudgetFinding`, `mediaBudgetFinding`). The name grammar a tag and
a field take, hyphens and an upper-case `XML` start among it (part 04, section 9, A9). The two lookup
reads and what each serves (part 05, section 10, B1).

**What it decides.**

- Which caps move, and to what. Known: HQ caps one workbook upload at 500,000 rows over all its sheets
  (`fixtures/upload/const.py::MAX_FIXTURE_ROWS`), and the research ("Reference targets") has Nova's
  per-table caps grow to hold any table HQ holds, a push split into workbooks under that cap, and a
  table too large for one workbook referenced and never pushed. Open: whether a table Nova cannot copy
  stays managed in CommCare HQ with no copy, and what Preview then shows.
- How Nova learns one table's row attributes. Known: the read that returns one table's rows serves no
  attribute, and the read that serves attributes returns every row of the project space (part 05,
  section 10.2).
- What holding an indexed field means. Known: no read an API key gives returns a field's indexed flag, a
  description or row owners (part 11, section 5.4), a managed table is never pushed to its own project
  space so none is erased there, and "Manage in Nova" says a push clears the first two
  (`LOOKUP_DISCARD_NOTE`). A table's description stays outside every step: no lookup upload carries one.
- The workbook that could carry a table tagged `types` (part 11, section 5.3).
- Whether a managed table's columns ever take a type. Known: text is the one type under which a re-read
  of what Nova wrote equals what Nova holds (part 11, section 5.2).
- Which place shapes Organization comes to hold, and the place limit. Known and outside this group
  unless a read comes to serve them: a level's worker and expand settings, which take Nova's defaults
  and are said in Organization and the review (part 11, section 11.3).
- An existing deployment that adopted a table carrying content Nova's model lacks stops at publish today
  (`hq_table_content_unsupported`, `lib/deployment/CLAUDE.md`). The research has this group's cutover
  clear that table's recorded baseline, so its first push stops at the drift check and offers to bring
  CommCare HQ's field properties, attributes, owners and globality in, which needs group 1's answer at
  the lookup stop.
- The shared name token, where the census puts this group before `forms-and-case-management`.

**Exit.** A base that reads tables at each cap, with each kind of content, and its places comes in; a
publish to its own project space writes none of them, and a publish to another creates them whole.

## 3. Settings Nova comes to own (`settings-nova-comes-to-own`)

The app settings that change what a form asks or stores, who owns a case, or what a menu looks like, so
that Nova must hold them and cannot leave them at CommCare HQ's value.

**Concepts.** Case sharing (`caseSharing`): a new case's owner comes from the worker's case sharing
group, HQ's build adds the `groups` instance and an entry assertion, and form logic may read the
worker's groups (`instance('groups')`, a `group-field` leaf), a read step 3 refuses at parse. The read
means the groups case sharing gives a worker, which HQ fills from each assigned location whose type
shares cases and from every HQ group with case sharing on
(`users/fixturegenerators.py::UserGroupsFixtureProvider.__call__`,
`users/models.py::CouchUser._get_case_sharing_groups_for_locations`,
`CommCareUser.get_case_sharing_groups`): state of the project space that Preview cannot show truthfully
until Nova holds the setting. Grid menus (`menuStyle`: the first menu, every form menu or some, and a
menu's own style). A form's own location capture (`Form.autoCaptureLocation`). Android apps the phone
must have. Build profiles Nova keeps in step with the app's languages. A language whose code Nova's
registry cannot name. Wording changed through a key CommCare HQ generates, where Nova holds no slot for
that text.

**Entries (10).**

- *Grid menus* (`menu-display`, 3): `application-and-settings/46-hq-use-grid-menus`,
  `application-and-settings/47-hq-grid-form-menus-none-all-some`,
  `menus-and-case-lists/module-display-style-list-grid-read-when-grid-form-menus-some-on`
- *Case sharing* (`case-sharing`, 2): `application-and-settings/39-hq-case-sharing`,
  `expressions-and-data/groups-jr-fixture-user-groups`
- *Android apps the phone must have* (`android-app-dependencies`, 1), `application-and-settings/`:
  `31-features-dependencies`
- *Build profiles* (`build-profiles`, 1), `application-and-settings/`: `build-profiles-non-empty` (A2)
- *A form setting* (`form-settings`, 1), `forms-and-case-writes/`: `auto-gps-capture-form`
- *A language code* (`language-codes`, 1), `application-and-settings/`:
  `langs-code-nova-s-language-registry-cannot-name` (B2)
- *Changed wording for a menu, form or list held in the app's translations* (`translation-overrides`,
  1), `application-and-settings/`: `translations-generated-key-anything-else` (B2)

**What step 6 builds toward it.** The kept test and its table
(`lib/commcare/surface/keptAtHq.ts::KEPT_AT_HQ`; part 01, sections 4 and 5): forty-nine rows from A3
and the fiftieth from B8, each a thing Nova leaves at the project space's value, with what the `.ccz`
does, what Preview does and what a first publish elsewhere does, and `TargetFacts` (A3), the typed
projection of a deployment's baseline that the `.ccz` and Preview read. The app-level entries above are
the ones that failed that test, each with the clause it failed (part 01, sections 3.7, 4.2 and 4.3):
case sharing changes who owns a case Nova's forms create, a grid needs Preview to draw it, a dependency
stops the app opening, a profile's languages fall out of step. A generated translation key that only
overrides one text Nova holds is folded into that text (part 01, section 7.1; part 06, sections 6.5
and 16.5, B2).

**What it decides.**

- The stored shape of each setting and its cutover. From the research's "Identity": each setting Nova
  starts to own is read from each existing deployment in the group's cutover, so no publish silently
  resets what a project space holds.
- Which kept settings Nova comes to own, if any. Known: nothing refuses an app over a kept row, so none
  blocks a bring-in. A kept row that only states a difference is what owning would retire: Preview marks
  every required question whatever the asterisk setting says, a `.ccz` carries no Android logo, no
  practice worker's restore and none of CommCare HQ's catalog text (`kept_android_logos_absent`,
  `kept_practice_worker_absent`, `kept_ui_text_falls_back`). The old outline held these as typed slots
  (`appSettings`, `androidLogos`, UI string overrides with `uiStringCatalogKeys`, per-language display
  names); step 6 keeps them, and a setting leaves `KEPT_AT_HQ` only in the pull request that makes Nova
  its author everywhere. Were display names to become an author's choice,
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
- Its platform rows: a form's location capture (ignored on Web Apps), grid menus (a grid's audio is
  ignored on Web Apps), Android app dependencies (ignored on Web Apps).

**Exit.** A base with case sharing on, grid menus and a form that captures location comes in, and each
setting Nova now owns publishes to a second project space as the person set it.

## 4. How a question looks (`question-display`)

The choices an author makes in the form builder about how a question is drawn, the media that differs by
language, and the label forms beyond text.

**Concepts.** The typed display vocabulary beyond the Phone Number question: each thing an author can
choose about a question's display as its own typed setting on exactly the kinds whose control reads it.
Part 03's table (section 2.4) shows the shape has a place for every entry: further keypad values, a
width, address lookup with its broadcast and receive topics, a hint as a placeholder, a reference to a
callout from another input, barcode scanning on open and an editable scan, a choice list's layout,
columns, advance and match, a calendar, a 12-hour clock, a map picker, a capture's source, recorder and
overlay, selectable text and a banner on a label, a group that is compact, collapsible or bordered,
questions per row and alignment. Its key names are working names and bind nothing. Media that differs by
language on a label, an option, a menu and a form (`localizedMedia`). The label forms (long text, inline
video, a QR code, speech). A translation that shows other values than its source text.

**Entries (64).**

- *How a question looks* (`question-appearance`, 56), `questions/`: `select1-minimal`,
  `select1-compact-compact-n`, `select1-quick`, `select1-quick-compact-n`, `select1-combobox`,
  `select1-combobox-multiword`, `select1-combobox-fuzzy`, `select1-list`, `select1-list-nolabel`,
  `select1-label`, `select1-button-select`, `select1-receive-topic-field`, `select-minimal`,
  `select-compact-compact-n`, `select-list`, `select-list-nolabel`, `select-label`, `secret-numeric`,
  `text-secret-numbers`, `short`, `medium`, `text-address`,
  `broadcast-topic-an-address-entry-under-the-gates-above-and`, `text-receive-topic-field`,
  `barcode-numeric-address-or-receive-topic-field`,
  `hint-as-placeholder-on-text-other-than-a-secret-without-numeric`,
  `hint-as-placeholder-on-any-other-entry`,
  `intent-id-on-any-input-other-than-an-intent-typed-one-where-id`, `barcode-quick`, `date-ethiopian`,
  `date-nepali`, `date-gregorian-gregorian-cancel`, `time-12-hour`, `geopoint-maps`, `barcode-editable`,
  `image-acquire`, `image-overlay-small`, `audio-legacy`, `audio-acquire-or-upload`, `audio-long`,
  `video-acquire`, `trigger-selectable`, `floating-good-floating-caution-floating-bad`,
  `a-label-whose-appearance-string-starts-with-floating-other-than`, `group-compact`,
  `group-group-collapse`, `group-collapse-open`, `group-group-border`,
  `n-per-row-any-question-or-group-other-than-a-vellum-repeat-n-one`,
  `n-per-row-repeat-group-with-a-repeat-as-a-direct-child-n-one-or`,
  `any-other-per-row-token-the-first-token-web-apps-per-row-pattern`,
  `text-align-center-text-align-right`,
  `multi-token-strings-e-g-minimal-hint-as-placeholder-signature-2`,
  `a-multi-token-string-holding-tokens-no-runtime-reads-on-that`,
  `a-single-string-no-row-names-that-holds-values-android-matches`,
  `a-case-variant-of-numbers-nepali-or-maps-of-video-acquire-or-of`
- *A picture, sound or label form on a question* (`question-media`, 4), `questions/`: `long-form`,
  `label-video-inline`, `label-qrcode`, `label-tts`
- *A picture or sound that differs by language* (`media-by-language`, 3):
  `menus-and-case-lists/media-image-media-audio-differing-by-language`,
  `forms-and-case-writes/media-image-media-audio-differing-by-language`,
  `questions/label-or-option-media-differing-by-language`
- *A question's text* (`question-text`, 1), `questions/`:
  `a-text-whose-languages-show-different-values` (B3)

**What step 6 builds toward it.** The rules every display setting follows, which bind this group and
which it does not change (part 03, section 2.1, A6); the registry
`lib/domain/fieldDisplay.ts::FIELD_DISPLAY_SETTINGS`, which the platform detector reads, so a new
setting needs no detector; and the one writer of `appearance`,
`lib/commcare/xform/appearance.ts::fieldAppearance`, whose token table the reader reads backwards (part
06, section 9.2, B3). So a setting here is a registry row, a schema key and a token row, with no
migration. A media reference that is the same in every language is held as the one shared slot (part 01,
section 3.5; part 06, B3), and a media file keeps CommCare HQ's path per deployment (part 10, section 4,
B8).

**What it decides.**

- Each setting's key and values, under part 03's rules. Where CommCare reads two tokens differently by
  their order, each order a platform reads differently is its own value or the reader's finding (rule
  4); the three multi-token entries are decided by that rule.
- A reading that holds only under a target gate needs an arm step 4's platform table lacks (its
  `PlatformBehavior` gives one reading per platform): `questions/text-address` runs on Web Apps only
  under `CASE_SEARCH_ADVANCED` and the `geocoder` privilege, and is unavailable there otherwise.
- The reference to a callout from another input
  (`questions/intent-id-on-any-input-other-than-an-intent-typed-one-where-id`) is this group's entry,
  and it needs the callout kind, which is `xform`'s: the manifest gives `xform` the three question
  kinds (`questions/acknowledge-label-a-trigger-whose-appearance-is-neither-exactly`,
  `questions/face-capture-image-face` and
  `questions/android-app-callout-input-appearance-intent-id-bind-type-intent`; part 01, Appendix A.1;
  part 03, section 2.4). So this group depends on `xform` for that one entry and for nothing else.
  Where `xform` is planned first, the kind exists and this group builds the reference. Where this
  group is planned first, its plan moves that entry's `owner` to `xform`, with this dependency as
  the reason, and `xform` builds the reference with the kind, under this group's rules. Either way
  no group's exit waits on a kind another group owns.
- The stored shape of per-language media, for every carrier at once: labels, options, menus, forms, and
  the Register action's icon and spoken label, which step 6 holds as one image and one sound for every
  language (part 02, section 11.8, A5). Each per-language slot joins
  `lib/domain/mediaRefs.ts::walkAuthoredAssetRefs`, so step 4's acceptance by declaration
  (`lib/media/platformPlayback.ts::unplayableReferences`, the commit kernel's media admission and the
  export rule `MEDIA_FORMAT_NOT_PLAYED`) judges each file on every platform the app declares.
- How a translation whose shown values differ from its source text is stored (part 06, section 12.5),
  given that prose parts hold identity and a changed shape re-fingerprints translations.
- Its platform rows: 51 of the 63 entries the manifest holds at `15a00a97` read `ignored` or `different`
  on a platform (26 are ignored on Web Apps and run on Android, 15 the reverse), so nearly every setting
  adds a feature row and Preview cells.

**Exit.** A base per palette question with each appearance HQ's form builder offers comes in, and a
multilingual base with media that differs by language republishes with each language's file.

## 5. Case lists and case details (`case-list-and-detail`)

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
settings. Auto-select on a multi-select list and a selection maximum above 100. A column the case detail
shows and the list does not carry. A filter, a calculated column or a sort calculation beyond what the
record rule set types.

**Entries (62).**

- *A case list or case detail column* (`case-list-columns`, 25), `menus-and-case-lists/`:
  `usexpathexpression-field-xpath-outside-valueexpression`,
  `1p-plain-over-a-property-select-questions-write`,
  `3-time-ago-time-ago-interval-the-7-menu-values-years-months`,
  `5pp-enum-key-that-is-empty-or-holds-whitespace`,
  `translatable-enum-on-a-column-that-is-not-a-calculated-property-over-a-property`,
  `translatable-enum-on-a-column-that-is-not-a-calculated-property-relation-does`,
  `6p-late-flag-late-flag-0`, `8-address`, `9-distance`, `11-geo-boundary`,
  `12-geo-boundary-color-on-the-case-list-only-needs-an-address`, `13-geo-points-on-the-case-list-only`,
  `14-geo-points-colors-on-the-case-list-only-needs-an-address`,
  `16-clickable-icon-endpoint-action-id-on-the-case-list`, `19-enum-image-whose-keys-are-plain-values`,
  `19pp-enum-image-whose-keys-are-conditions-of-any-other-form-dot`, `20-conditional-enum`,
  `more-than-one-address-column-in-a-detail-of-an-advanced-module`,
  `idx-prop-parent-host-any-index-names-other-than-a-first-step`, `owner-name`,
  `enum-mappingitem-alt-text-non-blank` (A9), `10-markdown-outside-the-link-shape` (A9),
  `21-translatable-enum-outside-nova-s-two-projections` (A9),
  `column-field-outside-nova-s-property-grammar` (B5), `6-late-flag-late-flag-1` (B5)
- *A case tile* (`case-tiles`, 9), `menus-and-case-lists/`: `detail-case-tile-template-icon-text-grid`,
  `long-detail-custom-tile-case-detail-laid-out-as-a-tile`, `detail-persistent-case-tile-from-module`,
  `detail-pull-down-tile`, `detail-persist-case-context-persistent-case-context-xml`,
  `case-tile-field-template-slot-on-icon-text-grid`, `invisible-or-address-column-in-a-custom-tile`,
  `a-custom-long-tile-row-mixing-fields-of-two-tabs-in-an-advanced`,
  `case-tile-group-identifier-outside-an-xml-element-name` (B5)
- *A lookup from the case list into another Android app* (`case-list-callout`, 8):
  `menus-and-case-lists/lookup-enabled-lookup-action`, `menus-and-case-lists/lookup-name`,
  `menus-and-case-lists/lookup-image-jr`, `menus-and-case-lists/lookup-autolaunch`,
  `menus-and-case-lists/lookup-extras-key-value`, `menus-and-case-lists/lookup-responses-key`,
  `menus-and-case-lists/lookup-display-results-lookup-field-header-lookup-field-template`,
  `expressions-and-data/session-data-fingerprintquery`
- *Tabs on the case detail screen* (`case-detail-tabs`, 5), `menus-and-case-lists/`:
  `7pp-invisible-inside-a-data-tab-over-a-nodeset`, `plain-tab-header-starting-index`,
  `tab-relevant-lifts-into-predicate-not`,
  `data-tab-over-child-cases-has-nodeset-nodeset-case-type-nodeset`,
  `data-tab-over-a-custom-nodeset-xpath`
- *The order of a case list* (`case-list-sorting`, 5), `menus-and-case-lists/`:
  `type-int-or-double-differing-from-the-derived-type-on-a-column`, `type-distance`,
  `display-lang-sort-by-label-on-a-sort-only-element`,
  `display-lang-on-a-sort-joined-to-an-invisible-column`,
  `sort-calculation-authored-calculation-row-field`
- *A case list speed setting* (`case-list-optimizations`, 2), `menus-and-case-lists/`:
  `module-show-case-list-optimization-options`, `optimization-cache-lazy-load-cache-and-lazy-load`
- *A list's own wording* (`case-list-text`, 2), `menus-and-case-lists/`:
  `detail-no-items-text-other-than-hq-s-default-en-list-is-empty`, `detail-select-text-non-default`
- *The worker's own record* (`worker-record`, 2), `menus-and-case-lists/`: `user-prop-usercase`,
  `user-steps-prop`
- *Choosing a case for the worker* (`auto-select`, 1), `menus-and-case-lists/`:
  `detail-auto-select-multi-select`
- *The case list filter* (`case-list-filter`, 1), `menus-and-case-lists/`:
  `detail-filter-value-outside-predicate`
- *How a case list is set up* (`case-list-setup`, 1), `menus-and-case-lists/`:
  `detail-max-select-value-above-100` (A9)
- *Data a form or list reads from the device* (`data-sources`, 1), `expressions-and-data/`:
  `search-input-results-read-in-the-search-results-detail`

**What step 6 builds toward it.** The reader of case lists and details: one set of columns from the two
details, the order plan, tiles (part 07, section 11, B5). A sort rule's blanks first or last (part 03,
section 7, A8). The record rule reader, under which a slot the checker refuses claims that slot's
HELD-NEW entry with the checker's reason, and the census counts them by entry (part 08, sections 8 and
9, B6). Part 08's table of every function in a record slot, with what each needs built (section 8.1).

**What it decides.**

- Functions in a list's filter, calculated column and sort calculation. Known: these slots are read by
  Postgres too, which decides which rows a list holds, and Core's coercions are not Postgres's
  (in commcare-core's `org/javarosa/xpath/expr/`, `FunctionUtils.java::toNumeric` reads date text as
  a day number, `XPathStringLengthFunc.java::evalBody` counts UTF-16 units and
  `FunctionUtils.java::normalizeCase` lowers in the device's locale), so each function needs a typed
  admission rule and a proof against Core before a list may depend on it. The census says which
  functions come first.
- A relation read through an index other than `parent` that names no case type, `#host` among them: it
  waits on an index whose case type the catalog knows (part 08, section 6.3), shared with `menus`.
- A column the list does not carry. From step 6 a column only the detail shows is read as a column
  hidden from the list and the review declares that a worker's list filter then matches it
  (`detail-only-columns-searched`; part 07, Departure 7). Holding it exactly retires that entry of the
  first-publish register (part 09, section 11.2, row 18). The same register's
  `sort-rule-kept-as-hidden-column` (row 15) stays: a sort rule over a property the list does not show
  is a hidden column in Nova's model, sorts the same, and this group's sort label sits on that column.
- Two things step 3 found and left byte-stable, each the HQ spelling of a concept here. *Sorting by a
  date and time:* sort keys over a date-and-time property sort the text
  (`lib/commcare/suite/case-list/sortKeys.ts`); HQ stores every such value as `…Z`
  (`form_processor/utils/xform.py::adjust_datetimes`), so synced cases sort right, while a case a device
  wrote before it synced carries its offset and can misorder. Step 3's instant lowering
  (`lib/commcare/xpath/wire/instant.ts`) can be the sort's `double` key. *The `date()` guard in
  generated columns:* the interval and flag columns (`lib/commcare/suite/case-list/columns.ts`) write
  `today() - date(x)` with only a blank guard, and Core's `date()` throws on text that is no date
  (`org/javarosa/xpath/expr/FunctionUtils.java::toDate`), which a detail shows as an invalid cell.
- The flag column with no list header: HQ's late flag shows none where Nova's interval column shows its
  own (part 07, Departure 1).
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

**Exit.** A base per column kind and per tab kind comes in, and `detail-only-columns-searched` is gone
from the register.

## 6. Menus (`menus`)

Menu structure and what a menu offers, beyond what step 6's stack A holds.

**Concepts.** Mirror menus (`Module.mirrorOf`), with the child mirrors HQ keeps in step, excluded forms
and a mirror's own form entry points. A badge on a menu or a form. Computed arguments on an entry point.
The remaining ways a case list offers a form: a follow-up form of the parent case, the action's display
condition, a host or a named form in an advanced menu, a form whose one registration of the type is a
child case, one form offered after an empty search by one list and always by another, the second return
of the after-empty-search arm, and a label with no text. `previous` on a form listed on the first menu,
and a link, an entry point or a Register return built through a first menu that shares one case. A
display condition beyond what the session rule set types, the worker's record in one among it. Nesting
across case types: a child menu of another case type under a parent with no forms, and a parent menu of
any other case type, an extension's host among them (part 04, section 11.2, N14). A case list menu
item with no name of its own.

**Entries (23).**

- *A form offered from the case list* (`case-list-registration`, 8), `menus-and-case-lists/`:
  `case-list-form-pointing-at-a-follow-up-form-of-the-parent-case`,
  `case-list-form-relevancy-expression-with-followup-forms-as-case`,
  `case-list-form-post-form-workflow-default-on-the-hidden-module-shape` (A5),
  `case-list-form-label-empty` (A5),
  `case-list-form-on-an-advanced-module-or-naming-an-advanced-form` (A5),
  `case-list-form-pointing-at-a-form-whose-one-registration-of-the-type-is-a-child-case` (A5),
  `case-list-form-naming-a-form-another-list-offers-after-an-empty-search` (A5),
  `case-list-form-on-a-host-under-a-menu-that-shares-the-first-menu-s-case` (A5)
- *A mirror menu* (`mirror-menus`, 4), `menus-and-case-lists/`: `shadowmodule-shadow-module-version-2`,
  `shadowmodule-v2-under-a-v2-shadow-menu-mirroring-a-non-shadow`,
  `shadowmodule-excluded-form-ids-non-empty`, `shadowmodule-form-session-endpoints-non-empty`
- *A menu's or form's display condition* (`display-conditions`, 3):
  `menus-and-case-lists/module-filter-value-outside-predicate-any-xpath-hq-s-validator`,
  `forms-and-case-writes/form-filter-outside-predicate-parent-host-user-usercase-reads`,
  `forms-and-case-writes/user-prop-in-module-filter-form-filter-case-list-slots-the`
- *Forms shown in the menu above their own* (`display-only-forms`, 2), `forms-and-case-writes/`:
  `post-form-workflow-previous-screen-on-a-form-listed-on-the-first-menu` (B4),
  `form-link-or-endpoint-through-a-first-menu-that-shares-one-case` (B4)
- *A badge on a menu or form* (`menu-badges`, 2):
  `menus-and-case-lists/custom-icons-0-badge-localized-text-or-xpath`,
  `forms-and-case-writes/custom-icons-0`
- *A deep link* (`deep-links`, 1), `forms-and-case-writes/`: `function-datum-endpoints`
- *A menu setting* (`menu-settings`, 1), `menus-and-case-lists/`: `module-case-list-label-empty` (B4)
- *How menus are nested* (`menu-structure`, 1), `menus-and-case-lists/`:
  `child-menu-of-another-case-type-under-a-parent-with-no-forms` (A9)
- *Choosing a parent case first* (`parent-selection`, 1), `menus-and-case-lists/`:
  `parent-select-naming-a-module-outside-the-declared-parent-type` (A9)

Three items of this group are no entry. *The case list menu item's media target for the tools:*
`setMenuMedia` gains `case-list-registration` in step 6 and no target for the menu item (part 02,
section 12 and decision 16, A5), though `Module.caseListMenuItem` holds the media. *A link to a mirror
menu:* a mirror's link frame (`_get_link_frame`'s retarget) and a `form_module_id` that names a mirror,
which arrive with mirror menus. *Search field reads in the forms of a child menu of a parent whose forms
read the search:* a narrow on the HELD entry
`expressions-and-data/search-input-read-in-form-expressions-of-an-inline-search-module`, which carries
no `owner`. From step 5 a form reads its menu's Search fields only in the forms of a menu whose forms
read the search (`caseSearchConfig.formsReadSearch`;
`lib/domain/expression/context.ts::FormExpressionFacts.formsReadSearchModule`) and in its
after-empty-search form (`Module.caseListRegistrationForm`), and a child menu of such a parent keeps
`search-answer-unavailable` (`INVALID_SEARCH_REF`, reason `not-forms-read-search`). This group decides
whether the parent's inputs reach the child's forms on Web Apps, and lifts the narrow where they do.

**What step 6 builds toward it.** Which screen lists what (`lib/domain/menuScreens.ts`), forms in the
menu above, and the six effects of HQ's `put_in_root` as rules (part 02, sections 4 to 9, A4). The
`always` arm of `Module.caseListRegistrationForm`, a discriminated union that admits a new `kind` with
no migration (part 02, section 11, A5). The menu reader, with after-submit links and deep links (part
07, sections 8 to 10, B4). A menu of any document type reaches the reader, which raises a mirror menu as
a finding (part 05, section 7, B1; part 06, section 7.1, B2).

**What it decides.** Each row with the reason step 6 gives it (part 02, sections 5.6 and 11.9).

- `previous` on a form listed on the first menu: which frame the form gets depends on every other menu
  above it, so one form's offered set moves with an edit to another menu, and this group brings the
  reconcile that makes that safe.
- The follow-up arm and the action's display condition exist only under the flag
  `FOLLOWUP_FORMS_AS_CASE_LIST_FORM`, so an authored condition makes an app need a project-space flag.
- An advanced host or form brings HQ's six rules
  (`app_manager/helpers/validators.py::AdvancedModuleValidator.validate_with_raise`) and a second
  source of return frames.
- Mirror menus: how a mirror and its child mirrors are held and kept in step, and the reader's map from
  the real form ids of the application resource to excluded forms and entry points.
- The relation work it shares with `case-list-and-detail` (an index whose case type the catalog knows),
  which a display condition's `#host` read and a parent menu of another case type both wait on.
- Its platform rows: a badge (different on Android, which hides `0` and shortens text over three
  characters) and a mirror's form entry points.

**Exit.** A base with a mirror menu, a badge and each arm of registering from the case list comes in.

## 7. Case search (`case-search`)

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

**Entries (42).**

- *A search filter* (`search-default-filters`, 13), `case-search/`:
  `default-properties-entry-keyed-by-a-plain-property-property-p`,
  `default-properties-entry-keyed-by-an-ancestor-path-parent-p`,
  `default-properties-entry-keyed-owner-id-case-id-commcare-project`,
  `default-properties-entry-keyed-commcare-sort-x-commcare-custom`,
  `default-properties-entry-keyed-case-type`,
  `default-properties-entry-keyed-commcare-blacklisted-owner-ids`,
  `blacklisted-owner-ids-expression-without-that-clause`,
  `blacklisted-owner-ids-expression-outside-valueexpression`,
  `hidden-exclude-without-a-default-value-on-a-prompt-with-no`,
  `hidden-without-exclude-on-a-prompt-with-no-itemset-input-type-or`,
  `hidden-on-a-prompt-that-carries-an-itemset-input-type-or`,
  `xpath-query-row-reading-a-field-hq-also-matches` (B5),
  `xpath-query-row-that-is-neither-a-list-filter-clause-nor-a-search-field-s` (B5)
- *A search field* (`search-fields`, 12), `case-search/`:
  `appearance-address-geocoder-broadcast-emitted-input-address`, `input-checkbox-itemset`,
  `itemset-nodeset-filter-predicate-outside-predicate`, `default-value-outside-valueexpression`,
  `allow-blank-value`, `receiver-expression`, `is-group-group-key`,
  `prompt-key-outside-nova-s-name-grammar` (A9), `default-value-on-a-date-range-input` (A9),
  `date-prompt-matched-by-hq-s-own-rule` (B5),
  `prompt-named-for-a-case-attribute-hq-matches-itself` (B5),
  `search-field-over-a-property-of-another-type` (B5)
- *How the search is set up* (`search-setup`, 11), `case-search/`:
  `custom-sort-properties-property-name-sort-type-exact-date`,
  `search-button-display-condition-outside-predicate`,
  `instance-name-without-casedb-ledgerdb-fixture-or-session-in-it`, `additional-case-types`,
  `custom-related-case-property`, `include-all-related-cases-false-where-nova-s-relation-reads`,
  `include-all-related-cases-authored-without-relation-reads`, `search-on-clear`,
  `list-first-with-a-search-that-skips-to-results` (B5), `search-on-a-put-in-root-module` (B5),
  `title-label-blank-in-some-languages` (B5)
- *A search expression* (`search-expressions`, 4), `case-search/`:
  `date-only-comparison-on-date-opened-closed-on-last-modified`,
  `a-search-value-that-queries-cases-a-table-or-places` (B6),
  `required-or-validation-test-outside-what-nova-types` (B6),
  `xpath-query-condition-outside-what-nova-types` (B6)
- *A deep link* (`deep-links`, 1), `case-search/`: `case-search-endpoint-id`
- *A case list filter its search doesn't share* (`list-and-search-filters`, 1), `case-search/`:
  `case-list-filter-clause-the-search-does-not-restate` (B5)

**What step 6 builds toward it.** A search with no title as its own arm (part 03, section 6, A8). The
search reader: whether a menu searches and its workflow, fields, settings, and the rows of
`_xpath_query` read as one conjunction, each conjunct held where Nova has a slot that writes it back
(part 07, section 12 and Departure 2, B5). The record rule and CSQL reader behind `readFormSyntax` (part
08, B6), and the record spelling `list(…)`, which is read and kept and never authored anew (part 08,
section 8.3).

**What it decides.**

- *A project space's day.* HQ compares a date with `date_opened`, `closed_on` or `last_modified` as the
  project's day (`case_search/xpath_functions/comparison.py::_create_system_datetime_query` and
  `::adjust_input_date_by_timezone`, with the zone from
  `util/timezones/utils.py::get_timezone_for_domain`, which reads
  `domain/models.py::Domain.default_timezone`). No read an API key gives returns a project space's
  time zone, so Nova's search keeps the worker's day for `today()` and the UTC day for a date coerced
  to a date and time. This group decides how such a comparison is held and how Preview evaluates it
  (part 08, section 7.5). Where it holds a search's `today()` as the project space's day, the declared
  change `search-today-device-day` leaves the register with its rewrite (part 09, section 11.2, row
  12).
- *Two independent filters.* Where a menu's forms do not read the search, HQ applies the list's filter
  to the list and the search's rows to the search, and Nova's one `caseListConfig.filter` is written to
  both. This group holds a search's own filter and a list's own filter (part 07, Departure 2). With the
  two held apart, the two shapes step 6 declares on a menu whose forms read the search are exact as
  well, a search row that joins the list's filter and a list clause the search is sent, and
  `search-filter-joined-to-list` and `search-restates-list-filter` leave the register (part 09, section
  11.2, rows 17 and 19).
- *What CommCare HQ matches itself.* A bare date field, a field over `case_id`, `owner_id` or `status`,
  and a plain default filter are matched with the project space's fuzzy and ignore-pattern settings,
  which a clause Nova writes ignores (part 07, Departure 3).
- *A search value that queries device data* (cases, a table, places), a search filter the record rule
  set refuses, and making the value-list card an editor, so all three editors can write a list (part 08,
  sections 7.6 and 8.3).
- *The results instance name* (`caseSearchConfig.resultsInstanceName`): until this group, form logic
  reads an inline search's results as `instance('results:inline')`, and from it the print reads the
  menu's effective name.
- *A case search endpoint*: the one reference to project data Nova cannot read.
- Functions in a search slot, which wait as they do in a list's slots (group 5; part 08, section 8.1).
- A list first whose search skips to its results (`auto_launch: false` beside `default_search: true`;
  part 07, Departure 10).
- Its platform rows: the geocoder input (unavailable on Android) and its receiver
  (`case-search/receiver-expression`, ignored on Android), search on clear and field groups (ignored on
  Android), allowing a blank value (ignored on Android), and the hidden fields Android shows.

**Exit.** A base per search workflow with each setting of the section comes in.

## 8. Forms and case management (`forms-and-case-management`)

What an advanced form loads and opens, and the case management rows steps 5 and 6 leave.

**Concepts.** Stored case selections per advanced form (`Form.caseSelections`). From step 5 a menu is
advanced exactly when its kind is held or one of its forms holds an advanced-placed operation, and an
advanced form's loads are derived from its menu's parent-selection chain, with no stored selection; from
step 6 the reader builds the chain from an imported form's loads and raises a form whose loads the chain
does not give (part 07, section 4 and Departure 5, B4). This group takes:

- several selected cases per form, and a second case chosen from another menu's list, of any type,
  beside the chain: its stored shape, a `DatumRef` for it (two selections from one list need identities
  `selected-case` cannot tell apart), its Preview list step, and its authoring (a builder control, a
  `selection` target on the case change tools, and its reads);
- a chain that differs between the forms of one menu, which HQ's page allows;
- a load that changes no case and carries a tag Nova does not derive, and a tag or an index name outside
  Nova's grammar;
- auto-selection: `Module.autoSelectSingle` (unavailable on Web Apps where one row matches and the datum
  has `detail-confirm`) and the four auto-select modes step 5 does not emit (it emits only the worker's
  record, as the advanced emission of a worker-record write);
- a case list of the worker's own record;
- computed datums (`Form.computedDatums`), which give `DatumRef` a `computed` kind
  (`{ kind: "computed"; form; datum }`) with its row in the entry's datum supplies
  (`lib/domain/entryDatumSupplies.ts`) and its id in
  `lib/commcare/formLinkProjection.ts::entryDatumIds`, so form logic reads one by identity, a navigation
  slot reads one as it reads a chosen case, and the advanced form's read of `supply_point_id` is held
  then; step 5's `commtrack-off` reason over the decoded source
  (`lib/commcare/planPrivileges.ts::commtrackReasons`) catches such a datum without change;
- a relationship chosen per submission, and a label as a write source;
- shadow forms (`Form.shadowOf`), of a basic or an advanced form, with their selection overrides;
- a child case type under more than one parent (the research's "Also held" list): the catalog holds one
  `parent_type` per type, and every walk through an index resolves through it.

Beside these: the writer-type joins (decimal, multi-select, text) and a date-and-time question saved
straight to a date property; a preload from any other index path, a preload held at the end of the load,
and a preload into a question that holds no default; saving only a changed answer beyond a follow-up
form's own update; a write or a load through an index whose case type the app does not state; a write to
`location_id` or `hq_user_id`; a case property name with a letter outside ASCII; a write through an
index named `user`; a submit label; an advanced menu Nova would write as a basic one; a record slot that
reads a session value the dialect cannot spell.

**Entries (33).**

- *The cases an advanced form loads or opens* (`advanced-forms`, 11):
  `forms-and-case-writes/auto-select-mode-raw-value-key`, `forms-and-case-writes/auto-select-mode-user`,
  `forms-and-case-writes/auto-select-mode-fixture`,
  `forms-and-case-writes/auto-select-mode-case-index-of-an-earlier-load`,
  `forms-and-case-writes/caseindex-relationship-question-relationship-question-the-index-naming-a`,
  `forms-and-case-writes/arbitrary-datums-datum-id-datum-function`,
  `expressions-and-data/session-data-supply-point-id-in-an-advanced-form-whose-computed`,
  `forms-and-case-writes/advanced-form-loads-other-than-its-menu-s-one-chain` (B4),
  `forms-and-case-writes/load-changing-no-case-with-a-tag-nova-does-not-derive` (B4),
  `forms-and-case-writes/case-tag-holding-a-hyphen` (B4),
  `forms-and-case-writes/index-identifier-outside-an-xml-element-name` (B4)
- *A question that loads a case value* (`case-preloads`, 5), `forms-and-case-writes/`:
  `case-preload-from-any-other-index-path-host-user-a-mixed-path`,
  `an-advanced-load-s-update-or-preload-or-an-open-action-s-name-or`,
  `loadupdateaction-preload-read-later-in-the-load` (B4),
  `case-preload-into-a-question-that-holds-no-default` (B4),
  `case-preload-into-a-question-outside-any-repeat-where-the-held` (B4)
- *A shadow form* (`shadow-forms`, 4), `forms-and-case-writes/`: `shadowform`,
  `shadow-parent-form-id-naming-an-advancedform-that-is-not-a`,
  `extra-actions-load-update-cases-repeating-a-parent-tag-overrides`,
  `extra-actions-load-update-cases-with-a-tag-absent-from-the`
- *Answers of different kinds saved to one case property* (`writer-types`, 4), `forms-and-case-writes/`:
  `writers-int-decimal`, `writers-single-select-multi-select`, `any-other-mixed-writer-pair`,
  `a-datetime-question-saved-straight-to-a-case`
- *A case property name* (`case-property-names`, 2), `forms-and-case-writes/`:
  `update-keys-location-id-hq-user-id` (A9), `update-key-holding-a-non-ascii-core-name-character` (A9)
- *A form's case management* (`form-case-management`, 2), `forms-and-case-writes/`:
  `update-mode-edit-off-a-follow-up-form-s-own-update` (B4),
  `index-path-through-a-case-type-the-app-does-not-fix` (B4)
- *The worker's own record* (`worker-record`, 2):
  `menus-and-case-lists/case-type-commcare-user-on-an-advancedmodule`,
  `forms-and-case-writes/update-key-whose-index-segments-include-user-each-parent-host-or`
- *An advanced menu* (`advanced-menus`, 1), `menus-and-case-lists/`:
  `advanced-module-nova-would-write-as-a-basic-one` (B4)
- *Choosing a case for the worker* (`auto-select`, 1), `menus-and-case-lists/`:
  `auto-select-case-on-an-advanced-module`
- *A form setting* (`form-settings`, 1), `forms-and-case-writes/`: `submit-label-non-default`

**What step 6 builds toward it.** The reader of basic and advanced forms, of placements and of the
session values an entry holds (`publishedCaseBlocks` extended, `hqEntryFacts`; part 07, sections 3 to 7,
B4). An advanced load's preload read as the question's default wherever nothing later in the load reads
the question, and an update through the date-and-time join, both HELD in B4. Hyphens in a case write's
property and the keys `category` and `state` (part 04, section 6, A9).

**What it decides.** Each shape above, and:

- a third advanced trigger becomes reachable, a form selecting a case beyond its menu's chain, which
  `lib/commcare/moduleKind.ts::emittedModuleKind` then reads, and a registration form that loads a case
  becomes possible, so the sync-on-form-entry predicate (`formEntrySyncReasons`) then reads the
  selection;
- a preload's place in the load. Known: HQ's build appends a load's preload setvalues after every
  setvalue the form holds (`app_manager/xform.py::XForm._create_casexml_advanced`), Nova writes a
  writer's starting value as its default, and the reader's rule is structural (`laterLoadReaders`; part
  07, Departure 9), so it may raise the finding for a form whose later reader happens to see the same
  value. A basic form's stored `case_preload` is appended the same way
  (`app_manager/xform.py::XForm._create_casexml`), and CommCare HQ's basic Case Management page draws
  no load section and keeps a stored one through its save, so step 6 holds that entry not-yet with
  this group as its owner, and never as something to change in CommCare HQ (part 07, section 14);
- the lane's fuzz sample draws no advanced menu (`proof/corpus/documents.ts::fuzzSplit`), though Vitest
  does (`lib/commcare/__tests__/advancedDocArbitrary.ts`): this group adds a fuzz family drawing
  advanced menus and step 5's link shapes, with its own sample, because the existing sample keeps its
  draws;
- what, if anything, is step 7's half of the research's contract row "A form's type is its own
  case's lifecycle". Known: the research's contracts table gives that row to steps 5 and 7, and
  `lib/domain/CLAUDE.md` has held the row's replacement sentence whole since step 5 ("Four form
  types", each its own case's lifecycle, with a registration that may close the case it creates and
  every other case's write a case operation). The research names no part of the row as step 7's,
  and no part of step 6's plan names one. Open: whether a sentence of that contract still changes
  when this group holds a form's stored case selections, in which case this group's plan names it,
  or the row was complete at step 5 and the plan that reads it strikes "7" from the row;
- the shared name token, where the census puts this group before `project-data-at-hq-size`;
- its platform rows: a submit label (`forms-and-case-writes/submit-label-non-default`, ignored on
  Android) and `Module.autoSelectSingle`
  (`menus-and-case-lists/auto-select-case-on-an-advanced-module`, unavailable on Web Apps where one row
  matches and the datum has `detail-confirm`).

**Exit.** A base with an advanced menu whose forms hold several selections, an auto-selected case, a
computed datum and a shadow form comes in, and the new fuzz family passes every proof.

## 9. What a form holds (`xform`)

The rest of what CommCare HQ's form builder writes into a form.

**Concepts.** New kinds of question: an acknowledge question (it holds an answer, which a label does
not, so it is a kind as signature is; part 03, section 2.4), face capture, and an Android app callout.
An image's maximum size. A repeat's add captions. A question's data under another group than its control
(`Field.dataParent`). A question locked in CommCare HQ (`Field.lockedInHq`). A Hidden Value's default
beside its calculate, its own bind type, and its data node's namespace. Choices from a query: a sort
column, a filter beyond what the record rule set types, and a source other than Nova's case-choices
shape. A choice value holding both quote marks. The form's pragma settings held as text (auto-submit,
the saved-form descriptor). Logic and text on kinds that hold none today: required and a hint on a
label; a validation condition and its message on a location question, a capture question or a label; a
default, help and help media on a capture question or a label. A Save to Case question at an authored
position, and the Save to Case shapes Nova's block does not have (a case type as an expression, an
authored case id, a block that closes beside another action, a condition on the owner, a link name
outside Nova's grammar). CommCare Connect: a work area update and a work area id expression, blocks
beyond one of each kind, an app that is both a learn app and a deliver app. A repeat over a model by the
load-time rule. A data root not named `data`, and a question named `case`, `registration` or `script`.
Form logic beyond what the form rule set types: comparisons Core coerces, `*` steps, reads of the blocks
HQ's build adds.

**Entries (39).**

- *A kind of question* (`question-types`, 9), `questions/`:
  `acknowledge-label-a-trigger-whose-appearance-is-neither-exactly`,
  `jr-imagedimensionscaledmax-250-500-1000px-or-another-positive`, `face-capture-image-face`,
  `android-app-callout-input-appearance-intent-id-bind-type-intent`,
  `data-parent-data-node-under-another-group-than-its-control`, `vellum-lock-all-locked-question`,
  `hidden-value-with-both-calculate-and-a-default-by-any-expression`,
  `data-node-xmlns-on-a-hidden-value`, `hidden-value-bound-a-type-nova-would-not-write` (B3)
- *A Save to Case question* (`save-to-case`, 8), `questions/`: `savetocase-case-type-given-as-an-xpath`,
  `savetocase-create-with-an-authored-non-uuid-case-id-xpath-inside`,
  `savetocase-expressions-outside-nova-s-typed-vocabularies-case-id`,
  `a-close-only-savetocase-block-with-a-close-condition`,
  `a-savetocase-block-that-creates-or-updates-and-also-closes-under`, `savetocase-owner-id-condition`,
  `savetocase-block-outside-nova-s-own-block-shape` (B4),
  `savetocase-link-name-outside-nova-s-identifier-grammar` (B4)
- *A question's text* (`question-text`, 5), `questions/`:
  `a-question-text-label-hint-help-validation-message-repeat-add`,
  `a-question-text-whose-itext-id-is-pragma-form-descriptor-where`, `hint-text-on-a-label` (A9),
  `help-text-on-a-capture-question-or-a-label` (A9),
  `validation-message-on-a-capture-question-or-a-label` (A9)
- *A CommCare Connect block* (`connect-blocks`, 4), `questions/`: `connect-work-area-update`,
  `connect-blocks-beyond-one-of-each-kind` (A9), `connect-deliver-unit-work-area-id-expression` (A9),
  `connect-learn-and-deliver-blocks-in-one-app` (B3)
- *A question's choices* (`question-choices`, 4), `questions/`: `itemset-sort-ref`,
  `itemset-filter-outside-predicate`, `itemset-over-casedb-or-another-instance-advanced-data-source`,
  `choice-value-holding-both-an-apostrophe-and-a-double-quote` (A9)
- *A question's logic* (`question-logic`, 3), `questions/`: `bind-required-on-a-label` (A9),
  `bind-constraint-on-a-capture-question-or-a-label` (A9),
  `default-on-a-capture-question-or-a-label` (A9)
- *A repeat group* (`repeats`, 2), `questions/`: `repeat-add-captions-jr-addcaption-jr-addemptycaption`,
  `model-iteration-repeat-outside-nova-s-model-iteration-rule` (B3)
- *An expression* (`expressions`, 1), `expressions-and-data/`:
  `a-form-expression-outside-what-nova-types` (B6)
- *A form's source* (`form-source`, 1), `questions/`: `data-root-element-named-other-than-data` (B3)
- *A question ID* (`question-ids`, 1), `questions/`: `question-id-case-registration-script` (B3)
- *A picture, sound or label form on a question* (`question-media`, 1), `questions/`:
  `help-media-on-a-capture-question-or-a-label` (A9)

**What step 6 builds toward it.** The form reader: structure, itext, prose, generated nodes folded back,
Connect blocks (part 06, B3). Save to Case blocks held in Nova's own shape, with the boundary stated as
four mechanical tests (part 07, section 5 and Departure 4, B4). The form-logic reader and the mapping
from a checker refusal to its entry, which this group narrows as it widens a rule set (part 08, section
9.2, B6). A calculated value in prose and a form whose text formatting is off (part 03, sections 4 and
8, A7 and A8). The seven slots a kind does not hold, each split from the row that holds it elsewhere
(part 04, section 2.2, A9).

**What it decides.**

- The Hidden Value's two sources. The contract "a `hidden` field carries exactly one value source"
  retires: `HIDDEN_VALUE_BOTH_SOURCES`, the tool-schema gate, `editField`'s clearing of the held slot
  and the builder's one Value control each change ("Contracts", below).
- The three new kinds (the acknowledge question, face capture and the Android app callout), which are
  this group's entries and are built under part 03's display rules (part 01, Appendix A.1; part 03,
  section 2.4). `question-display` needs the callout kind from this group for its one reference to a
  callout from another input (`questions/intent-id-on-any-input-other-than-an-intent-typed-one-where-id`).
  Where this group is planned after `question-display`, that entry's `owner` has moved here, and
  this group builds the reference with the kind.
- A new slot on up to seven field kinds for each of validation, a default, help and a hint, each with
  its editor, its Preview check and its emission (part 04, section 2.2).
- Connect blocks beyond one of each kind: `lib/domain/connectIds.ts::connectBlocks` reads one block of
  each kind per form and every Connect surface rests on it; and one `connectType` for an app.
- Model iteration by the research's load-time rule ("Load-time values") in place of step 5's structural
  rule (part 06, section 10.4).
- Its platform rows: the acknowledge question (different on Web Apps, which answers one itself, so a
  required one never blocks), face capture (a plain image upload on Web Apps), the Android app callout
  (unavailable on Web Apps as the date-and-time question is: the client holds "Not Supported by Web
  Entry" as the answer, so the question is refused where Web Apps is declared), an image's maximum size
  (ignored on Web Apps), a Hidden Value's default beside its calculate
  (`questions/hidden-value-with-both-calculate-and-a-default-by-any-expression`, different on Web Apps,
  where the default inside a repeat row never reaches a submission), and the two pragma settings (one
  runs on each platform).

**Exit.** A base per question kind of the form builder's palette comes in, with a Save to Case question
at an authored position.

## 10. A second project space (`second-project-space`)

A team keeps a copy of its app in another project space, staging beside production, and wants Nova to
update that copy too.

**What step 6 leaves.** An app is brought in from one project space, and its HQ ids live in ledger rows
for that deployment alone (`app_deployment_identities`, `app_deployment_media_paths`; part 10, sections
3 and 4, B8). Every other project space takes Nova's derived ids, so a publish there makes a new app,
beside any copy the team already has. Step 6 says so three times: in the review ("If your team keeps a
copy of this app in another project space, Nova can't update that copy yet. Publishing there makes a new
app."; part 13, V21c), in the publish dialog's plan line for such a project space (D7), and in the docs.
One HQ app is managed by one Nova app, by a unique index over live app mappings (part 10, section 5),
and a copy in another project space is another HQ app, so nothing stops one Nova app from managing both.

**What it needs.** An adoption for a deployment that is not the app's birth: the copy read, compared
with the Nova document before anything is written, its ids recorded for that deployment, its claim
taken, and its baseline stored with origin `read`. It owns no manifest entry.

**What its full plan decides.**

- How the copy's entities are matched. Known, read at the pin: a copy made through CommCare HQ's own
  copy, unlinked, keeps each menu's `unique_id` and each form's `xmlns` and gives every form a new id
  (`app_manager/views/apps.py::copy_app` and `::_copy_app_helper` to
  `app_manager/models/applications.py::import_app_from_id`, whose `Application.export_json` runs
  `scrub_source` and `app_manager/util.py::update_form_unique_ids`). So part 10's keys match such a
  copy to the Nova app, and its form ids are the copy's own, as they are on every deployment. The same
  page makes a linked app where the person asks for one (`::_create_linked_app`), and a reading stops
  on a linked app (`linked-app`; part 01, section 8.3), so a linked copy is outside this group as it
  is outside step 6. Open: a copy that has since been edited apart, where there is no common baseline
  and the comparison is of two documents, not three.
- What a difference does: whether the copy must read to the Nova document exactly before Nova adopts it,
  or group 1's review decides each difference.
- Project data there. Known: a Project table managed in CommCare HQ follows one project space ("it can't
  follow two"; part 11, section 7), a publish to another project space creates a managed table and the
  places from Nova's copy, and the copy's project space may already hold its own. Known too, at the
  pin: CommCare HQ's copy into another project space copies each table the app reads into that project
  space, under a suffixed tag where the tag is taken, and rewrites the copy's references to the new tag
  (`app_manager/lookup_table_import.py::copy_lookup_tables`, `::_destination_tag`,
  `::rewrite_lookup_table_references`). So a copy can read a table under another tag than the Nova
  document's, and its plan decides whether such a table is matched to the Project's by content or the
  copy reads as differing there.
- What the first publish to the copy changes, said from the register as it is for the first.
- The act itself: where it is offered (the publish dialog's plan line is where the person learns of it
  today) and its MCP tool.

**Exit.** An app brought in from one project space adopts its copy in a second, and a publish updates
both with no new app made.

## What step 6 settled of the old outline

Each item the outline this replaces listed, by name or through the inventory's concept list its groups
were, that step 6 holds or decides. The rows cover the twenty entries that leave HELD-NEW in step 6
(part 01, section 3.8). Everything else the old outline listed is under a group above. The identifier
grammars an HQ author types were never the old outline's: they were the widenings of HELD rows the
outline of step 6 gave step 6, and part 04 holds them (A9).

| The old outline's item | Old group | Settled by |
|---|---|---|
| held media paths | 1 | part 10, section 4 (B8) and part 11, section 4.4 (B9): a file keeps CommCare HQ's path as a row of `app_deployment_media_paths` for the project space it came from, and no path is stored in the document; `expressions-and-data/media-path-jr-file` is HELD |
| the fifteen profile settings Nova seeds, the logging of case detail views, the persistent menu and breadcrumbs | 2 | part 01, section 3.6 (A3): kept at CommCare HQ's value, with a `.ccz` that mirrors them |
| `androidLogos` | 2 | part 01, sections 3.6 and 4.3 (A3): kept; a `.ccz` carries none and says so |
| UI string overrides with `uiStringCatalogKeys` | 2 | part 01, sections 3.6 and 4.4 (A3): kept; an app that holds them comes in |
| per-language display names | 2 | part 01, section 7.2 (B8): kept; an absent name stays absent on a deployment Nova brought in |
| the app-level `auto_gps_capture` off a Connect app | 2 | part 01, section 3.6 (A3): kept; `Form.autoCaptureLocation` stays with group 3 |
| the thirteen profile seeds on step 4's ambient list | 2 | part 01, section 3.6 (A3): they leave `AMBIENT_PLATFORM_ENTRIES` and `PLATFORM_CELLS` as kept entries |
| "display only forms", and a display-only menu as a link target | 3 | part 02, sections 3 to 9 (A4) |
| a registration form in another menu, always offered, with its icon, its spoken label and its own after-submit | 3 | part 02, section 11 (A5) |
| a sort rule's blanks first or last | 4 | part 03, section 7 (A8) |
| an advanced load's preload read as a default; an update through the date-and-time join | 6 | part 07, sections 3.7 and 14 (B4) |
| the Phone Number question, of `Field.appearance` | 1 | part 03, sections 2 and 3 (A6) |
| a calculated value in prose, the inventory's prose expression part (`questions/output-value-any-other-expression`) | 7 | part 03, section 4 (A7): HELD as a prose `value` part |
| a search with no title (`case-search/title-label-or-blank-hq-s-default`) | 5 | part 03, section 6 (A8): HELD as `searchScreenTitle: { kind: "none" }` |
| a form whose text formatting is off, the inventory's `Form.plainText` (`questions/vellum-ignore-containing-markdown-on-h-html-vellum-s-disable`) | 6 | part 03, section 8.3 (A8): HELD as `Form.plainText` |
| several `_xpath_query` rows, each kept as its own row (`case-search/several-xpath-query-rows`) | 5 | part 01, section 3.5, and part 07, section 12.3 (B5): HELD, read as one conjunction and written back one row a top-level conjunct |
| a media reference holding its path with no file (`expressions-and-data/a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map`) | 8 | part 11, section 13.1 (B9): split into an INERT entry, where no runtime the app runs on draws the slot without its file, and a REFUSED one beside it |

## Contracts

The research's contracts table gives step 7 these rows, each now with its group.

| Contract row | Group |
|---|---|
| A Hidden Value may keep its default beside its calculate (`lib/domain/CLAUDE.md`, `components/builder/CLAUDE.md`, `lib/commcare/CLAUDE.md`) | `xform` |
| The case detail tile is held (`docs/architecture/contracts.md`, "Long-detail tiles are out of scope") | `case-list-and-detail` |
| A form's type is its own case's lifecycle, the step 7 half | open, and asked under `forms-and-case-management` ("What it decides"): the research gives the row to steps 5 and 7 and does not say which part is step 7's |
| `case_sharing` and every other held setting as a key-level overlay | `settings-nova-comes-to-own` |
| The document's external identities | settled: language wire codes are held since step 2; from step 6 a menu's and a form's HQ ids, its `xmlns` and a media file's path are ledger rows of a deployment and no document slot (part 10, B8), and B14 words mental model 3 of the root `CLAUDE.md` to say so |

Group 1 adds rows of its own to "HQ deployment safety" in `docs/architecture/contracts.md`: the drift
rule gains bringing a change in beside discarding it, and the commit kernel gains a change kind.

## The groups, and the order

| Order | Group | Id | Entries it owns when step 6 exits |
|---|---|---|---|
| first, by step 6's plan | Changes made in CommCare HQ | `changes-made-in-hq` | none |
| by the census, else second | Project data at CommCare HQ's size | `project-data-at-hq-size` | 13, and four circumstances |
| by the census, else third | Settings Nova comes to own | `settings-nova-comes-to-own` | 10 |
| by the census, else fourth | How a question looks | `question-display` | 64 |
| by the census, else fifth | Case lists and case details | `case-list-and-detail` | 62 |
| by the census, else sixth | Menus | `menus` | 23 |
| by the census, else seventh | Case search | `case-search` | 42 |
| by the census, else eighth | Forms and case management | `forms-and-case-management` | 33 |
| by the census, else ninth | What a form holds | `xform` | 39 |
| last | A second project space | `second-project-space` | none |

The eight groups in the middle are listed, and numbered above, in the order `STEP_7_GROUPS` gives their
ids. That is the order of work wherever the census does not decide: while no reading holds a not-yet
finding, while the person has not run the inspector, and between two groups the census ties on both
columns. Otherwise, when a group exits, `scripts/inspect-hq-readings.ts` runs again, and the group with
the most apps for which it is the only thing between them and coming in is planned next, a tie going
to the group with more apps holding any of its findings. The pull request that plans a group moves
that group's row to stand first among the middle rows not yet planned, rewords its Order cell to
"planned, by the census" or "planned, by this list", and writes no count. 286 entries in all.
