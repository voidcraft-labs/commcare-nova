# Step 6, part 15: The stacks, contracts and the exit

Part of [step 6's plan](../6-bring-in.md) ("Bring in an app from CommCare HQ"), which holds the
baseline, the decisions and the list of parts. Citations are `path::symbol` for Nova at `main`
`15a00a97`. This part makes one CommCare claim of its own, read at source ("Executed during
planning", 10); every other CommCare fact it writes into a contract sentence is a fact another part
settled at the pins `proof/pins.json` names (commcare-hq `d6c6e16d8ae1`, commcare-core
`8e9ba8d908e9`, commcare-android `7a5584475580`, commcare-connect `046c7fd78081`, formplayer
`24383ac71bfb`, Vellum `01215f251c57`), and it carries that part's citation with it.

This part plans four pull requests in full, the ones no other part plans: **A10** (the agent: the
guide as stack A leaves it, the version the stack deploys, the one billed schema check of stack A),
**A11** (contracts and public docs for stack A), **B14** (contracts and public docs for stack B) and
**B15** (removal of this plan). And it assembles the whole: both stacks pull request by pull request,
their order, their house rules, the model-addition checklist for each new concept of stack A, every
migration and production read, every contract sentence and public page that changes, every gated run
of every part in one table, and the exit as checks a machine runs.

Where a pull request is named by id anywhere in this plan, the id is the one in section 1. A part is
cited by its number and section, with the pull request beside it; the file names are these:

| Part | File | Plans |
|---|---|---|
| 01 | `01-the-bar-and-the-manifest.md` | A2, A3, the manifest and copy lines of B1 to B10 |
| 02 | `02-menus.md` | A4, A5 |
| 03 | `03-questions-and-text.md` | A6, A7, A8 |
| 04 | `04-names.md` | A9 |
| 05 | `05-reading-commcare-hq.md` | B1 |
| 06 | `06-the-reader-forms.md` | B2, B3 |
| 07 | `07-the-reader-cases-menus-lists.md` | B4, B5 |
| 08 | `08-the-reader-expressions.md` | B6 |
| 09 | `09-acceptance-and-the-first-publish.md` | B7 |
| 10 | `10-identity-and-the-ledger.md` | B8 |
| 11 | `11-project-data.md` | B9 |
| 12 | `12-the-reading-and-the-birth.md` | B10 |
| 13 | `13-the-experience.md` | B11, B12 |
| 14 | `14-proof.md` | A1, B13, the proof lines of every pull request |
| 15 | this file | A10, A11, B14, B15, both stacks |

| Section | Holds |
|---|---|
| 1 | both stacks, pull request by pull request, the merge order in one table (1.0), and every pull request's files |
| 2 | ordering constraints, and why no pull request is split |
| 3 | house rules for the stacks |
| 4 | the model-addition checklist, applied to each new concept of stack A |
| 5 | migrations, the production reads, and why step 6 has no cutover |
| 6 | every contract, `CLAUDE.md` and architecture sentence that changes |
| 7 | public docs, by page |
| 8 | the research and proof documents, stale manifest cells, the step 7 rewrite |
| 9 | the nova-plugin check |
| 10 | every gated run of every part, in one table |
| 11 | the exit, for stack A and for stack B |
| 12 | the whole plan's departures, and what became of the outline's ten items |
| 13 to 16 | A10, A11, B14 and B15, each in full |

Counts are of `main` at `15a00a97`, read for this part: `lib/models.ts::MODEL_CONTEXT_VERSION`
`"v6-hq-round-trip-case-writes.14"`, `lib/db/appTests.ts::RUNTIME_VERSION` 18,
`scripts/test-schema.ts::SCHEMA_TESTS` 63 entries, the newest migration
`lib/case-store/migrations/20261112010000_retained_conversation_sources.ts`,
`proof/known-defects.json` `[]` and `proof/checks/registers.py::OPEN_DEFECTS` `{}`. `../nova-plugin`
is read at `0a67203`, whose `.claude-plugin/plugin.json` holds `"version": "2.4.2"` and whose
`.dev-plugin/.claude-plugin/plugin.json` holds `"1.31.0"`.

## Decisions in brief

1. **Twenty-six pull requests in two `gh stack` chains, none split.** Stack A, "What a plain app
   holds", is A1 to A11 in id order. Stack B, "Bring in", is B1, B2, B3, B4, B5, B6, B8, B9, B7, B10,
   B11, B12, B13, B14, B15 (part 09, Departure 14: acceptance calls the ledger's and project data's
   functions, so B7 lands above B8 and B9). Section 1.0 holds the order as one table of position,
   id, name and what each depends on. Each stack merges together for one deploy (section 2).
2. **Stack A merges and deploys before stack B is cut.** Stack B is cut from the `main` that holds
   stack A, and it merges no sooner than the first green scheduled night after stack A is live,
   because its pull requests read `main`'s evidence store and until that night the store holds no
   record made under stack A's keys (part 14, section 12.2).
3. **`MODEL_CONTEXT_VERSION` moves nine times, or ten.** `"v7-hq-round-trip-bring-in.a4"`, `.a5`,
   `.a6`, `.a7`, `.a8`, `.a9`, then `.b6`, `.b9`, `.b12`. A10 writes `.a10` only where its billed
   check forces a correction to a served tool or the guide; otherwise stack A deploys `.a9`. Stack B
   deploys `.b12`. **`RUNTIME_VERSION` moves once**, 18 to 19, in A9 (section 1).
4. **Four ledgered migrations, each additive and safe while the previous revision serves**:
   `20261113000000_hq_round_trip_lookup_names` (A9), `20261201000000_hq_bring_in_ledger` (B8),
   `20261202000000_hq_bring_in_project_data` (B9), `20261203000000_hq_app_readings` (B10). They ride
   their stack's ordinary deploy. **Step 6 has no document migration, no maintenance window, no
   notice, no Job and no announcement** (section 5). The one exception is written out: where A5's
   scan finds an app and the person says yes for it, that app is repaired once through the fenced
   Job runner, and nothing of the repair stays (section 5.3).
5. **Two billed schema checks, each asked once and run only on the person's yes.** Stack A's is this
   part's run H1 at A10's head, over every Solutions Architect tool whose served hash moved between
   `main` and that head: twenty-three are expected (section 13). Stack B's is part 13's run E1 at
   B12's head, held to the hash run the same way: `getLookupTables` and `getOrganization` are
   expected (section 3, rule 7). No other pull request sends anything.
6. **A10's own diff is `scripts/test-schema.ts` and nothing a model is served**: the prompts of the
   entries stack A gave a new input, so each billed request asks for a call that uses it, and the
   header's list of names. The guide's sentences each landed with the behavior that makes them true
   (A4 to A9); A10 reads the guide whole and changes it only where H1 forces a correction.
7. **A sentence moves with the behavior that makes it false.** Every subtree `CLAUDE.md` row lands
   in the feature pull request, so each subtree contract is true at every head. The four
   architecture files and the public docs land in A11 and B14 (`docs/architecture/complex-apps.md`
   in A11; `contracts.md`, `complex-apps.md`, `deployment.md` and `multilingual-localization.md` in
   B14; sections 1.2 and 6.4), with four recorded exceptions: A3 lands its own
   three public pages and its `contracts.md` paragraph (its `KEPT_AT_HQ` cells point at the section
   it writes); A1 and B13 land their sentences of the root `CLAUDE.md`'s `proof/` bullet; B11 lands
   `design/readme.md` with the screens it describes; and B3 lands `docs/testing.md`'s sentence with
   the Vitest project it names (sections 6 and 7).
8. **Where a part left a text to A11 or B14, the text is written here**: nine texts of
   `docs/architecture/complex-apps.md` for parts 02 and 03 (one paragraph rewritten, two new
   subsections and six new paragraphs), the three public sections on data managed in CommCare HQ
   for part 11, four `mcp/tools.mdx` rows, and one new `complex-apps.md` section on bringing an app
   in (sections 6.3, 6.4 and 7).
9. **Eleven contract sentences the parts did not list are rewritten here**, each read in its file:
   the root `CLAUDE.md`'s "a one-way emission boundary", its `lib/commcare` sentence on the barrel
   and three clauses of its `lib/deployment` paragraph; two `complex-apps.md` sentences on the
   ledger and on preflight; one sentence each of `docs/architecture/multilingual-localization.md`
   and `lib/domain/expression/CLAUDE.md`; and two of `lib/commcare/CLAUDE.md` that still say
   "one-way" once its opening does not. With them go two source comments and the Biome rule's
   message, which say the same thing, one sentence of `proof/README.md` that counts the proofs, and
   one manifest cell that names what "import" would ask (sections 6, 8 and 12.3).
10. **B15 removes this plan and one script, and keeps one.** `docs/plans/hq-round-trip/6-bring-in.md`,
    the `6-bring-in/` directory and `scripts/scan-hq-app-claims.ts` leave (the outline left earlier,
    in this plan's own pull request);
    `scripts/inspect-hq-readings.ts` stays, because it runs again whenever a step 7 group is planned.
    B15 writes the plans `README.md`'s "Step 6 is done" (section 16).
11. **Three production reads, each read-only, content-free and asked first**: A5's scan for a
    registration form that also creates a same-type child at its root, B8's scan for an HQ app two
    live Nova apps publish to, and the census read at the exit that orders step 7 (section 5).
12. **One nova-plugin pull request a stack, merged only after that stack's deploy is live.** Stack
    B's is part 13's (a new skill, `2.4.2` to `2.5.0`). Stack A's exists only where the sweep at A10's
    head finds a sentence stack A makes false; at `0a67203` it finds none (section 9).
13. **The exit is checked by machine**, once for each stack, after its merge and its first scheduled
    night (section 11). The outline's exit condition stands as part 14's Departure 7 words it: every
    base comes in, republishes and passes its proofs, every variant is refused or held as its
    `expected.json` says, and every manifest entry is base-exhibited, variant-exhibited or exempt.
14. **Thirteen decisions reach across two parts and are made here** (section 12.3), and each part
    named there says what was decided. Three change what a pull request writes: row 16 of
    `FIRST_PUBLISH_CHANGES`, `list-settings-respelled`, gains the two search text paths part 07 asks of
    it, in B7; the Biome rule's message stops calling `lib/commcare` a one-way emission boundary, in B7;
    and stack B's billed check is held to the hash run, as stack A's is.

## Executed during planning

For this part: read-only. No file of the repository or of `../nova-plugin` was changed but this one,
and no Docker, lane, test suite, typecheck, build or billed call ran.

1. **The counts at `main` `15a00a97`**, by `rg` and a `python3 -I` read: the two version literals,
   the newest migration's stamp, and `scripts/test-schema.ts`'s 63 entries by name. Of the 104 tools
   `lib/agent/sharedToolRegistry.ts` gives the Solutions Architect, 42 have no entry in the script,
   `setFormSections` and `getOrganization` among them; one entry, `uploadMediaAsset`, is a tool only
   MCP serves.
2. **Who serves `CASE_LIST_REGISTRATION_DESCRIPTION`**, by `rg`: `lib/agent/tools/createForm.ts` and
   `lib/agent/tools/updateForm.ts` both put it in an input's description, so A5's closing sentence
   moves both tools' served hashes (claim corrected, below).
3. **`lib/hostnames.ts`**: the main host's allowlist holds `"/api/commcare"`, so the six routes of
   part 12 (B10) and the two of part 13 (B11) need no entry, as those parts say.
4. **Every "today" quote of a row this part writes itself** was read in its file with `rg` and `sed`:
   the root `CLAUDE.md` (mental model 3, the `lib/commcare`, `lib/deployment`, `lib/lookup` and
   `lib/db` paragraphs), `docs/architecture/contracts.md` (app birth, "HQ deployment safety"),
   `docs/architecture/complex-apps.md` ("Export, publishing, and the deployment record", the nested
   menus paragraph, "Register when nothing matches"), `docs/architecture/multilingual-localization.md`,
   `lib/domain/expression/CLAUDE.md`, `docs/architecture/deployment.md`, and
   `content/docs/claude-code/commands.mdx`. The rows a part words are that part's, quoted there.
5. **The words a rewrite could leave false**, by `rg` over every `CLAUDE.md`, `docs/architecture/` and
   `content/docs/` outside `docs/plans` and `docs/research`: "one-way", `explicit-blank`, "stored
   nowhere", "before ids were derived", "import" as a verb for bringing an app in, and the names
   `6-import`, `7-rest-of-model`, "step 6" and "step 7" over the whole tree.
6. **The research's contracts table** (`docs/research/2026-09-26-hq-round-trip/README.md`, "Contracts
   this work changes"), read whole: five rows name step 6, each placed in section 6.1.
7. **`../nova-plugin` at `0a67203`**, by `rg -i` over `skills`, `agents` and `README.md` for every
   claim stack A changes (a menu's own screen, registration from a case list, `{{`, Markdown wording,
   a keypad, blanks, a search title, a hyphen in a name, "at least two"): no skill states one. The
   only hits are the `upload_to_hq` skill's sentences on `get_deployment` and `refresh_deployment`,
   which part 01 read and left true, and the two "render as a markdown table" lines of `find` and
   `list`, which are about Claude's own output.
8. **Step 5's stack in `git log --oneline 2f985ed6..ab43bf09`**: its plan (#832) and its sixteen
   pull requests (#837 to #855) in stack order, the removal last. Six titles are a sentence of what
   the pull request does (#838, #840, #841, #843, #844, #845), three are a topic (#849, #852, #854)
   and seven carry a step or stack label (#837, #846, #847, #848, #850, #853, #855). Step 6's stacks
   keep the order and take the first kind of title, which is also what `main`'s recent commits are
   (section 3, rule 1).
9. **Which tools hold a wording position**, by `rg` for `proseTemplateSchema` under `lib/agent`:
   `toolSchemaGenerator.ts` (the field tools and `setFieldOptionsSource`), `planningSchemas.ts`
   (`generateSchema`, `updateCaseProperty`) and `tools/setFormSections.ts`. `createForm.ts`,
   `createModule.ts` and `updateForm.ts` hold none.
10. **Two CommCare HQ symbols, for one citation** this part writes into `complex-apps.md` (section
    6.4): `models/applications.py::Application.scrub_source` calls
    `app_manager/util.py::update_form_unique_ids` with an empty map, so a source read serves a new id
    for each form, and `api/resources/v0_4.py::ApplicationResource.dehydrate_module` serves each
    form's stored `unique_id`. Both read with `rg` in the checkout at `d6c6e16d8ae1`. Every other
    CommCare fact here is another part's, cited as that part cites it.
11. **The fourteen parts**, each read in its own section at every seam this part writes: every
   "Files by pull request", "Contracts and docs these changes make false", "Departures", "Written
   and not yet run" and every need a part addresses to part 15 under "What this part needs of other
   parts", each held against the others that name the same file, sentence, run or pull request.
12. **The sweeps of runs H2 and H5, run as written at `main`** (free reads, seconds): each command
    parses, and each prints the lines its run states. A phrase searched as fixed text on one line
    misses three of the sentences it is there for, because their files wrap them
    ("`explicit-blank |` / `design-slice`" in `lib/db/CLAUDE.md`, "Five sources / feed it" in
    `proof/README.md`, "an inline source with at least two / UUID-identified options" in
    `components/builder/CLAUDE.md`), so every phrase is a pattern matched across line breaks.
13. **How the repository writes a production document from a script**, for section 5.3:
    `scripts/lib/selectStartingValueRepair.ts::migrateSelectStartingValues` (#879), its two bundle
    lines in the `Dockerfile`'s `maintenance-build` stage, its arms in
    `scripts/rollout/deploy-cloud-run.py::_effective_execution_args` and
    `docs/architecture/deployment.md`, "Historical repairs".

**Claims corrected and gaps found while planning this part**, for `harness-findings.md`, "Found
while planning step 6". Each bullet about a part says what that part held when this part was
planned. The part now says what this part decides, so the two agree, and the bullet stays to say
why (section 12.3 holds each as a decision).

- Part 02, run G5, named two tools for the billed check (`updateModule`, `setMenuMedia`). A5 also
  adds a sentence to `CASE_LIST_REGISTRATION_DESCRIPTION`, which `createForm` and `updateForm` serve,
  so four tools move in A4 and A5. The hash rule of section 3 finds them, and both are on A8's list
  already, so the billed check's list does not grow.
- Part 03 had A7 register `setFormSections` in `scripts/test-schema.ts` and gave the entry no
  prompt. Section 13 writes it.
- Part 03, section 9.2, mapped a text's path to its prose slot for `createForm` and `createModule`
  among others. Neither tool holds a wording position at `main` (item 9 above), as part 04's
  "Executed during planning" also finds, so A7's `text` description is not expected to move either
  (section 12.3).
- Part 06, "Contracts", said the root `CLAUDE.md`'s mental model 3 stands. Its clause "a one-way
  emission boundary enforced by a Biome import rule" is false from B2, where part 06's own row takes
  "One-way emission boundary" out of `lib/commcare/CLAUDE.md`. Section 6.2 rewrites the clause in
  B14 and keeps the sentence part 06 meant, "The SA and the builder never speak CommCare".
- Part 07, "What this part needs of other parts", asked part 09 for two more `paths` on row 16 of its
  register; part 09's section 11.2 held the row without them. Decision 14 settles it.
- `lib/commcare/surface/entries/gates.json`, entry `project-space-setting/Domain.commtrack_enabled`:
  its `content` ends "import asks the same from step 6". Step 6 asks no confirmation when an app is
  brought in (part 07, Departure 11; part 10, section 6.5; part 12, Departures), and no part corrects
  the cell. A2 removes the clause (section 8.3).
- `docs/architecture/complex-apps.md`, "Export, publishing, and the deployment record": "An adoption
  is never inferred: the publish REFUSES" and "The `project-data`, `organization`, and project-space
  compatibility edges talk to HQ during preflight" are each made incomplete by B8 and B9, and no part
  lists either. B14 completes both (section 6.4).
- The outline's "Cutover and migration" promises one cutover. Step 6 has none: ownership of a lookup
  table is derived (part 11, Departure 5) and every new stored slot is optional or a wider grammar.
- Part 14, "Contracts", gave the root `CLAUDE.md`'s register sentence a replacement for a quoted
  fragment. The file's sentence goes on after the fragment, "(`proof/known-defects.json`), whose
  entries for a fixed defect move to `proof/fixed-defects.json`", and a replacement of the fragment
  alone would hang that clause on the first-publish register. Section 6.2 writes the sentence whole.
- "One-way emission boundary" is said in five places no part listed, each read at `main`: the last
  sentence of `lib/commcare/CLAUDE.md`'s opening and its capture URL node bullet, the header of
  `lib/commcare/xform/captureUrlNode.ts::AttachmentUrlTarget`, the header comment of
  `lib/commcare/xpath/index.ts`, and the four messages of `biome.json`'s rule on `@/lib/commcare`,
  which part 06's section 2.4 left as they were. Section 12.3 decides each.
- Part 02, section 16, had `scripts/migrate-case-list-registration-registrations.ts` change a
  production app and named no writer, identity or `app_changes` kind for it. Section 5.3 does.
- Part 13's run E1 named two tools and said no other entry is sent. Section 1.3 has every pull
  request record the tools whose hash moved, so a move E1 does not name would be recorded and never
  checked. Section 3, rule 7, holds E1's list to the hash run.

## Written and not yet run

Every run here is on GitHub's runners, in the implementer's shell as a single billed command the
person approved, or a free local read. None is a heavy run on the person's machine. Each outcome
names what lands and where. Section 10 lists these beside every other part's runs.

**H1. The billed schema check of stack A, at A10's head.** Asked once, as the first act after A10's
own CI is green, in the words of section 13. On the person's yes the implementer runs `npm run
test:schema -- <name>` once for each name on the list, never the bare command.

- *Outcome A, every request answers without error:* A10's description records each name and its
  pass. `MODEL_CONTEXT_VERSION` stays `"v7-hq-round-trip-bring-in.a9"`, the value stack A deploys.
- *Outcome B, the provider refuses a schema or a description:* the correction lands in A10, in the
  tool's own file, with `lib/models.ts` moved to `"v7-hq-round-trip-bring-in.a10"` (a served byte
  changed), the tool's guide sentence corrected where the correction changes what it teaches, and
  that one entry sent again on a fresh yes. Stack A then deploys `.a10`, and part 08's B6 moves from
  `.a10` to `.b6`.
- *Outcome C, the person says no, or not now:* nothing is sent and A10 is not merged, so stack A
  waits. The question is asked again when they next open the stack.

**H2. The contract sweep at A11's head.** Two commands, run as written from the repository's root.
Each phrase is a pattern whose spaces are `\s+` and which `-U` matches across a line break, because
these files wrap their prose. Run at `main` `15a00a97`, the first finds nine of its patterns, each in
a sentence sections 6 and 7 rewrite (the other seven are names no contract file holds today, kept so
that a sentence written during the stack cannot carry one in), and the second finds six stale cells
of section 8.3 and "Five sources" in two files. So a silent command is evidence and not a miss.

```
git ls-files -z -- '*CLAUDE.md' docs/architecture content/docs design | xargs -0 rg -n -U \
  -e 'caseListRegistrationFormOf' -e 'caseListFormReturnFrame\b' -e 'previewMenuModuleUuids' \
  -e 'reservedNamespaces' -e 'SELECT_TOO_FEW_OPTIONS' -e 'namespaceOf' \
  -e 'PROFILE_PROPERTY_ONLY_ANDROID_READS' -e 'showFormsInParent' -e 'formsInParentMenu' \
  -e 'at\s+least\s+two\s+((fully\s+)?UUID-identified\s+)?options' \
  -e 'without\s+the\s+hyphen' -e 'quotes\s+dropped' \
  -e 'a\s+quote\s+mark\s+is\s+dropped' -e 'direction\s+\+\s+priority' \
  -e '`category`,\s+and\s+`state`' -e "HQ's\s+unrelated\s+\`put_in_root\`"

rg -n -U -e 'Field\.appearance:\s+numeric' -e 'Module\.showFormsInParent' \
  -e 'always\s+writes\s+the\s+markdown\s+form' -e "step\s+7's\s+migration\s+writes" \
  -e 'buildMultimediaMap' -e 'import\s+asks\s+the\s+same' -e 'Five\s+sources' \
  lib/commcare/surface/entries proof/README.md proof/CLAUDE.md proof/corpus/documents.ts
```

The first reads the contract files and the public docs. The second reads the manifest's cells, where
`Field.appearance` stays the slot of every appearance step 7 owns and only the Phone Number cell
loses it, and the lane's documents. The "at least two" pattern is bound to a select's options, the
three sentences that say it today, so no other use of the words can hit.

- *Outcome A, neither command prints a line:* A11 is complete as sections 6 and 7 write it.
- *Outcome B, a hit in a subtree `CLAUDE.md`, a manifest cell or a lane document:* the sentence went
  false in the pull request whose behavior changed it; the replacement is written there as a fix-up,
  in the voice of section 6's rows, and the restack rides the session's one push.
- *Outcome C, a hit in `docs/architecture/` or `content/docs/`:* the sentence is rewritten in A11 and
  added to section 7's table in the pull request's description.

A source comment that names a retired symbol is not this sweep's: section 1.4's importer command
finds it in the pull request that retires the symbol, where each hit is read.

**H3. The docs build and its links, at A11's head and at B14's head.** Each pull request's own CI
build, which builds the docs pages through fumadocs.

- *Outcome A, the build passes:* the pages ship as written.
- *Outcome B, a page fails to compile, or a link names a heading or a page that does not exist:* the
  page or the link is fixed in that pull request. B14's new page is linked from four pages
  (`index.mdx`, `building-with-nova.mdx`, `publishing.mdx`, `claude-code/commands.mdx`) and listed in
  `content/docs/meta.json` (section 7.2); a link to it from a page of A11 would fail, and section 7
  gives A11 none.

**H4. The `../nova-plugin` sweep at A10's head.** `rg -i` over `skills`, `agents`, `.dev-plugin` and
`README.md` of the plugin at its head then, for the claims of section 9.1, against the guide and
tool text A10's head serves.

- *Outcome A, no sentence stack A makes false* (what `0a67203` gives): stack A has no plugin pull
  request, `plugin.json` does not move, and A11's description records "swept at `<plugin sha>`, no
  claim".
- *Outcome B, a sentence stack A makes false:* one pull request in `../nova-plugin` corrects it in
  `skills/` and in its `.dev-plugin/skills/` mirror, with both `plugin.json` versions at their next
  patch (a correction teaches no new command). It is opened beside A10, merged only after stack A's
  deploy is live, and A11's description carries its link.
- *Outcome C, the plugin's head moved past `2.4.2`:* the sweep runs over the new head as in A or B,
  and every version this plan names for the plugin is the next one from whatever it holds then.

The same sweep runs at B12's head, for stack B's claims (section 9.2), against the tool text B12
serves: with no sentence beyond part 13's section 16, the plugin's pull request carries that
section's edits; a further sentence stack B makes false joins the same pull request before it merges,
at the same version; and a head that moved takes the next minor from what it holds.

**H5. The contract sweep at B14's head.** Four commands for the names and phrases stack B retires,
written as H2's are and run as written from the repository's root. Run at `main` `15a00a97`, the
first finds thirteen of its patterns, each in a sentence sections 6 to 8 rewrite (the other nine are names
no contract file holds today); the second finds the one-way phrase again, with `biome.json`'s four
messages and two source comments (section 12.3); the third finds one line; and the fourth finds six.

```
git ls-files -z -- '*CLAUDE.md' docs/architecture docs/testing.md content/docs design \
  proof/README.md | xargs -0 rg -n -U \
  -e 'listAppBuilds' -e 'resolveUploadDomain' -e 'invalidKeyMessage' -e 'settingsErrorMessage' \
  -e 'MEDIA_INSTALL_PATH' -e 'REWRITE_SENTENCES' -e 'CANDIDATE_IDS' -e '\bNotConfigured\b' \
  -e 'proof/corpus/hq\b' -e 'reading_reads' -e '6-import' -e '6-bring-in' \
  -e '[Oo]ne-way\s+(CommCare\s+|`lib/commcare`\s+)?emission' \
  -e 'emission\s+boundary\s+is\s+one-way' -e 'enforces\s+the\s+one-way\s+direction' \
  -e 'Both\s+ways\s+an\s+app\s+is\s+born' -e 'All\s+three\s+use\s+one\s+genesis\s+writer' \
  -e 'explicit-blank\s+\|\s+design-slice`' -e 'the\s+three\s+edges\s+that\s+TALK' \
  -e '[Pp]roofs\s+1\s+to\s+5' -e 'seven\s+`/nova:\*`\s+commands' \
  -e 'is\s+runtime\s+read-only:\s+only\s+a\s+migration\s+writes\s+it'

rg -n -U -e '[Oo]ne-way\s+(CommCare\s+|`lib/commcare`\s+)?emission' \
  -e 'emission\s+boundary\s+is\s+one-way' lib app components proof scripts biome.json

rg -n -U -e '[Pp]roofs\s+1\s+to\s+5' docs/plans/hq-round-trip/README.md

rg -n -w -i -e 'imported|importing' content/docs
```

The last is "import" as a verb for bringing an app in, and each hit is read. At B14's head it prints
four lines, each about something else that keeps the word: records that came from elsewhere
(`building-with-nova.mdx`), a CSV that replaces a table's rows (`project-data.mdx`), and the
CommCare HQ app file (`project-space-compatibility.mdx`, `publishing.mdx`). The two lines of
`case-workspace.mdx` it prints at `main` are the ones section 7.2 rewrites. "Proofs 1 to 5" is
three places at `main`: the root `CLAUDE.md`, a heading of `proof/README.md` and a sentence under
its "Native proofs" (section 8.2). Where the lane's documents speak of the proofs an app made in
CommCare HQ passes on its first publish, B13 writes "the first five proofs", so the pattern hits no
sentence that stands.

- *Outcome A, the first three commands print nothing and the fourth prints those four lines:* B14 is
  complete as sections 6 and 7 write it.
- *Outcome B, a hit in a subtree `CLAUDE.md`, a lane document, a source comment or `biome.json`:* as
  H2's outcome B, in the stack B pull request whose behavior made the sentence false.
- *Outcome C, a hit in the root `CLAUDE.md`, `docs/architecture/` or `content/docs/`:* the sentence
  is rewritten in B14, in the voice of section 6's stack B rows, and added to its table in the pull
  request's description.

**H6. The exit of stack A**, after its merge and its first scheduled night (section 11.1's checks).

- *Outcome A, every row holds:* stack B is rebased onto that `main` and its first pull request opens.
- *Outcome B, a row the lane or `main`'s CI checks fails* (rows 1 and 2 in the lane and the night,
  rows 3 and 4 in CI): the failing group or test is read from the night's issue or the CI run, fixed
  in an ordinary pull request with its own `/code-review medium`, and the row's check repeats. Stack
  B is not opened for merge until the night is green.
- *Outcome C, the deploy's row fails* (row 5): the deploy did not go live, so nothing of stack A is
  served and nothing is rolled back; the failing check-run is read, fixed forward in an ordinary pull
  request, and the row repeats. A migration that refused blocks the deploy with nothing changed
  (section 5.1).
- *Outcome D, the served contract's row or the contracts' row fails* (rows 6 and 7): fixed in an
  ordinary pull request; a plugin pull request, where H4 opened one, waits until row 6 holds.

**H7. The exit of stack B**, after its merge and its first scheduled night (section 11.2's checks).

- *Outcome A, every row holds:* step 6 is done; H8 follows.
- *Outcome B, a row the lane or `main`'s CI checks fails* (rows 1 to 5 and 7; rows 4 and 7 are CI
  alone): as H6's outcome B. A `proof6`, `parity`, `source` or `changes` difference takes no register
  entry (part 14, section 11.3): it is fixed in the reader or the emitter, or the shape becomes a
  `not-yet` entry with its owner and a variant.
- *Outcome C, the deploy's row fails* (row 6): only forward. A migration's guard that refused (part
  10's statement 8) leaves the previous revision serving with nothing changed, and part 10's run G1
  is made again. A row of `kysely_migration` missing after a green deploy is a defect of the deploy
  and is read from its `migrate` check-run before anything is rerun.
- *Outcome D, the served contract, the removal or the contracts' row fails* (rows 8, 9 and 10):
  fixed in an ordinary pull request; the plugin pull request waits until row 8 holds.

**H8. The census, at the exit.** `npx tsx scripts/inspect-hq-readings.ts --prod`, read-only, as the
person's gcloud identity, asked first and run by the person. It prints three tables of counts and no
app, project space, Project or person (part 12, section 8.2).

- *Outcome A, the first table names at least one app a group alone keeps out:* step 7's groups after
  `changes-made-in-hq` are planned in the order of that table's second column, most apps first. A
  tie goes to the group with more apps in the first column, and a tie on both to the group listed
  first in `7-rest-of-model.md`'s closing table, "The groups, and the order", which is the tie rule
  that file states. The order is written into `7-rest-of-model.md` by the pull request that plans
  the next group.
- *Outcome B, no reading holds a `not-yet` finding yet* (nobody has read an app Nova cannot hold, or
  nobody has read one at all): the order after the first group stays the outline's own, as
  `7-rest-of-model.md` lists the groups, and the census is read again before each group is planned.
- *Outcome C, the person says no, or not now:* nothing is read; outcome B's order stands meanwhile.

**Gated runs other parts own whose outcomes change rows here.** Each owner's part writes every
outcome in full; the rows of this part that move with it:

| Run (owner) | Outcome that changes this part | Rows here that change |
|---|---|---|
| G6 of part 02, the first menu's shared case | B | section 1's A4 row gains `targeted-forms-in-menu-above-shared-case` (stack A adds twenty-one documents); section 4's "validator" cell for display-only forms loses `FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE` and the reason `first-menu-shared-case` of `ENTRY_POINT_INVALID`, and its cell for registration from the case list loses the reason `parent-shares-first-menu-case` of `CASE_LIST_REGISTRATION_HOST_SHOWS_FORMS_ABOVE`; A5 and B4 each leave out one manifest entry (section 10.1); section 6.3's "Forms in the menu above" text loses its last sentence; `nested-menus.mdx`'s section loses the sentence that begins "Where every form shown on the first menu" |
| G3 of part 02, the return frames | B or C | section 4's validator cell for registration from the case list, and under C one HELD-NEW entry more in A5, and in A11 `case-workspace.mdx`'s section "Register from the list" gains, after the sentence that ends "which goes on to this menu's forms for it.", "On a menu whose forms read the search, only **Back to this list** is offered." (part 02, G3 outcome C and "Contracts") |
| G5 of part 03, Android's keypad | B or C | section 7's `where-workers-use-your-app.mdx` sentence, as part 03's "Contracts" words each outcome; section 6.3's "The Phone Number question" paragraph takes the note that outcome writes |
| G4 of part 03, plain help on Android | B | `plainHelp` leaves A8: section 4's rows for plain help, the `plain_help` input on H1's prompts, section 6.3's "Text shown as typed" paragraph and the two public sentences that name a help text shown as typed |
| G1 and G3 of part 03, a value the form builder or Core changes | B, or G3's C | section 4's validator cell for calculated values gains the one code that outcome adds; section 6.3's "A calculated value in text" paragraph gains its sentence; section 1's B6 row lands the claim of that outcome's entry, by the predicate A7 exports (part 08, sections 9.1, 9.2) |
| G2 of part 03, label text read as an instance | B | section 6.3's "Text CommCare HQ reads as an instance" paragraph is not written, and `lib/commcare/CLAUDE.md`'s A7 sentence on `hqInstanceScan.ts` with it |
| R2 of part 04, the names' documents | any fallback | the grammar that outcome keeps narrow leaves section 4's row and A9's manifest count, and the public sentence that names it (`commcare-connect.mdx` for hyphens in a Connect id, `case-changes.mdx` for hyphens in a saved property, `mcp/tools.mdx` for a choice value or a one-option select) keeps today's wording |
| Run 1 of part 01, the `.ccz` mirror | a row moves to not-yet | section 7's `publishing.mdx` list of kept settings loses that setting, in A3 |
| G2 and G7 of part 05 | C, B | the circumstance counts of section 1's B1 row (seven becomes six, or five) |
| E4 of part 08 and G2 of part 10 | B | `FIRST_PUBLISH_CHANGES` holds 35 or 36 entries; section 11.2's row 5 reads the count from the registry and pins none |
| G1 of part 10, the duplicate-claim scan | B | B8 does not merge until the scan answers A (section 5.3) |
| R1 of part 11, a replacing upload | B | B9 does not merge as written; section 1's B9 row gains the refusal `managed-table-shares-the-space` |
| E1 of part 13, stack B's billed check | B or C | section 3's rule 7; section 11.2's row 8 waits on it |
| P1 of part 14, the probe | B, C1, C2 | section 1's rows for the stack A pull request that outcome names; A1 does not merge until the probe's gate passes |
| P2 of part 14, every base | R, B, C1, C2, D | the stack B pull request that outcome names is amended on the stack; under D stack B does not merge |
| K4 of part 09, acceptance's budget | C | the ceiling of forms part 06's R2 states, in B7; where 75 forms do not fit, stack B does not merge and the person is told |
| M1 of part 12, the check's memory | B | the ceiling of forms part 06's R2 states, in B10, the smaller of K4's and M1's standing; where 75 forms do not fit, stack B does not merge and the person is told |
| M1 of part 12, the check's memory | C | section 1's B10 row: part 05's `lib/commcare/hq/appReading.ts` and its test join B10's changed files, `HqAppReading`'s `read` arm without `application` |

## 1. The stacks

Each stack is one `gh stack` chain on the latest `origin/main`, merged together for one deploy. Each
row's checks are in addition to the repository's ordinary checks at that pull request's own head:
typecheck, lint, Vitest with Postgres, the production build, the pull request lane in CI, the
Playwright smoke and the Python infra tests. No row runs a served reader, a lane slice or a suite on
the person's machine. "Parts" names every part that writes into the pull request, the owner first.
"Runs" names the gated runs that belong to the row; section 10 holds each with its outcomes.

"Lane" is part 14's section 12.1. A pull request reads `main`'s evidence store and its own, never
its base's, so a pull request above one that moved every part key observes every document itself.
A1 changes the observation's code and B13 its records, so every pull request of stack A, and B13,
B14 and B15, run the whole lane without the readers afresh on every push: 14.0 minutes modelled at
`main`, 14.4 at stack A's head, 15.5 at stack B's. B1 to B12 run the package groups, the judges
whose files they change and the documents they emit anew.

### 1.0 The merge order, in one place

Each stack is one chain, and position is the order from the bottom of the chain: position 1 is cut
from `main`, and each later pull request is stacked on the one before it. An id is a name and not a
position: stack A's ids run in order, and stack B's do not, because B7 sits above B8 and B9. Every
other statement of order in this plan (decision 1, the tables of 1.1 and 1.2, section 2.1, the
titles after rule 13, the top-level file's stacks table, and each part's own sentence on where its
pull request sits) follows this table. "Depends on" names the pull requests whose code or schema
the row needs, with section 2.1's reason; a row also sits on every row beneath it.

| Stack | Position | Id | Name in this plan | Depends on |
|---|---|---|---|---|
| A | 1 | A1 | Lane groundwork and the probe base | this plan's own pull request, merged |
| A | 2 | A2 | Manifest schema and the emission-side re-cuts | A1 |
| A | 3 | A3 | Kept at CommCare HQ's value | A2 |
| A | 4 | A4 | Display-only forms | A2 |
| A | 5 | A5 | Registration from the case list, always offered | A4 |
| A | 6 | A6 | The Phone Number question | A2 |
| A | 7 | A7 | A calculated value in prose | A6 |
| A | 8 | A8 | Text and lists | A7 |
| A | 9 | A9 | Identifier grammars | A2, A3, A5, A8 |
| A | 10 | A10 | Agent | A4 to A9 |
| A | 11 | A11 | Contracts and public docs for stack A | A10 |
| B | 1 | B1 | HQ reads | stack A merged, deployed and through its first green scheduled night |
| B | 2 | B2 | The reader's frame | B1 |
| B | 3 | B3 | The reader: forms | B2 |
| B | 4 | B4 | The reader: case management, menus and links | B2 |
| B | 5 | B5 | The reader: case lists and search | B2, B4 |
| B | 6 | B6 | The reader: expressions | B2, B3, B4, B5 |
| B | 7 | B8 | Identity and the ledger | B2, B6 |
| B | 8 | B9 | Project data | B6, B8 |
| B | 9 | B7 | Acceptance and the first-publish register | B4, B5, B6, B8, B9 |
| B | 10 | B10 | The reading and the birth | B7, B8, B9 |
| B | 11 | B11 | The experience | B10 |
| B | 12 | B12 | MCP, the guide and the billed check | B9, B10, B11 |
| B | 13 | B13 | Proof at full | B1 to B10 |
| B | 14 | B14 | Contracts and public docs for stack B | B13 |
| B | 15 | B15 | Removal of this plan | B14 |

### 1.1 Stack A, "What a plain app holds"

| # | Title | Parts | Contains | Migration | Manifest, registers, corpus | Versions | Lane | Checks and runs |
|---|---|---|---|---|---|---|---|---|
| A1 | Lane groundwork and the probe base | 14 | the sixth corpus source `hq-authored`, whose A Nova never sent; the package `proof/matrix`, which makes a base through CommCare HQ's own views, models and form builder and retains it under `proof/hq-apps/<base>/`; the one base `hq-plain` with a hand-written document, an edit, five value expectations and `restore.xml`; `operations.save_authored_app`; the `hq-authored` arm of each of the five lane readers of a first publish; the capture's publish over that A with its identity overrides; the case database seeded from A; `eligibility.hq_authored`; proofs 1, 2 and 3 asking `changes.declared`; `proof/first-publish-changes.json` begun, strict both ways, with `CANDIDATE_IDS`; `python3 -m proof.matrix.adopt` (part 14, sections 2, 3, 4, 9.1, 9.2, 14). No product code: `git diff --stat main..<A1> -- lib app components` is empty | none | no manifest entry; `proof/known-defects.json` stays `[]`; the first-publish file holds one object for each candidate the probe's evidence gave a row; corpus gains `hq-plain` | none | whole lane, every part key moves; a push here starts eleven lanes | part 14's A1 tests (`proof/matrix/test_retained.py`, `test_seed.py`, `test_expectations.py`, `proof/corpus/__tests__/publish.postgres.test.ts`, `emitCorpus.test.ts`); **P7** in its own CI; **P1** by hand. A1 is settled on its own branch and does not merge until a probe run's gate passes |
| A2 | Manifest schema and the emission-side re-cuts | 01, 04, 10, 15 | the six derived standings and the derived fix cause (`surface/standing.ts::standingOf`, `fixCauseOf`); `subject` on every HELD-NEW and REFUSED entry and `owner` on every HELD-NEW entry; three value classes; the TARGET-OWNED schema arm; five manifest test rules; the re-cuts no code change makes true; the finding type, `READ_CIRCUMSTANCES` (twenty codes), `CIRCUMSTANCE_STANDINGS`, and the finding copy file as A2 leaves it (part 01, sections 2, 3.1 to 3.4, 3.7, 8, 9.1 to 9.3); the `xmlns` entry's cell in part 10's words; the stale `commtrack_enabled` cell (section 8.3 here) | none | two new INERT entries, one new HELD-NEW (`application-and-settings/build-profiles-non-empty`), three value classes, the stale cells and the ten "outside" pairs re-worded; `subject` on 587 entries and `owner` on 238; after A2 the coverage line reads 472 of 1,253 entries held, 26 kept, 168 inert, 238 not yet, 93 never, 256 to change in CommCare HQ; no lane verdict moves | none | whole lane; ten lanes a push | `surface/__tests__/manifest.test.ts`, `standing.test.ts`, `lib/publish/__tests__/hqFindings.test.ts`, `hqFindingCopy.test.ts`; no gated run. Before A2 opens its implementer files the build profiles issue of section 3, rule 12, and names its number in A2's description |
| A3 | Kept at CommCare HQ's value | 01 | twenty-three entries become TARGET-OWNED; `surface/keptAtHq.ts::KEPT_AT_HQ` (49 rows) with its binding test; `TargetFacts` and its projection from the stored baseline source; the view-capable `readTargetFacts`; the `.ccz` mirror (profile settings, UI text, the secure receiver, a custom base URL's origin, location capture, the `<credentials>` block) and three kept export advisories; Preview's list filter with Core's accent fold and fuzzy match, and the `preview-target-facts` frame; the Publishing card's kept list with **Refresh from CommCare HQ**; MCP `refresh_deployment`'s `kept_values` and `deployment.kept`; its three public pages and its `contracts.md` paragraph (part 01, sections 3.6, 4, 5, 6, 9.4 to 9.7) | none; `AppBaselineWrite.origin` is widened in TypeScript only | fifteen HELD, six HELD-NEW and one REFUSED entry become TARGET-OWNED, one entry splits; thirteen rows leave `AMBIENT_PLATFORM_ENTRIES` and `PLATFORM_CELLS`; corpus gains `targeted-kept-values` | none: the two tools it changes are served by MCP alone | whole lane; nine lanes a push | part 01's section 10 tests (`keptAtHq.test.ts`, `keptArchive.test.ts`, `refreshKeptValues.postgres.test.ts`, `preview-kept.spec.ts` among them); **Run 2** in its own CI; **Run 1** by hand with the readers. Before A3 opens its implementer files the issue of part 01's section 6.4 and names its number in A3's description |
| A4 | Display-only forms | 02 | `Module.formsInMenuAbove`; the projection `lib/domain/menuScreens.ts` and `screenChoosesCaseFirst`; the validator rules of forms in the menu above; `put_in_root`, `menu_mode`, the `<menu>` id, root, text and conjoined condition and every stack frame through `menuIdOf` on both emitters; Preview and App Tests by the projection; the module settings switch; `updateModule.forms_in_menu_above`, the reads and the guide paragraph (part 02, sections 2 to 9, 12, 14, 15) | none | `menus-and-case-lists/put-in-root-display-only-forms` HELD-NEW to HELD; its REFUSED sibling gains its lane reader; `application-and-settings/menu-mode`'s cell re-worded; the `display-only-forms` not-yet sentence leaves `FINDING_COPY`; corpus gains four targeted documents (five under G6's outcome B), the native family `menu-screens`, the edit kind `setFormsInMenuAbove` and the fuzz corpus `menu-screens` | `MODEL_CONTEXT_VERSION` `.a4` | whole lane; eight lanes a push | part 02's "Tests" for A4, `menu-above.spec.ts`; the corpus emission at base and head (new refusals meet no stored shape); **G1**, **G4**, **G6** in its own CI; **G2** by hand |
| A5 | Registration from the case list, always offered | 02 | the `always` arm of `Module.caseListRegistrationForm`; the readers of `menuForms.ts` with `caseListRegistrationFormOf` renamed `afterEmptySearchRegistrationFormOf`; the app rule `caseListRegistrationApp` and the reason `several-registrations`; `case_list_form` with its workflow word and media, the Register action on both short details, one or two return frames; Preview's Register action and return; the removal refusal; the platform row `case-list-registration-media`; `updateModule.register_from_case_list` and `setMenuMedia`'s third target (part 02, sections 10 to 16) | none | two entries HELD-NEW to HELD, two re-cut, six HELD-NEW, one REFUSED and one INERT added; one lane reader; one platform cell; corpus gains `targeted-register-from-case-list` and the family's A5 half | `.a5` | whole lane; seven lanes a push | part 02's "Tests" for A5, `register-from-list.spec.ts`; **G1**, **G3** in its own CI; **G2** by hand; **the A5 scan** (section 5.3) before it merges |
| A6 | The Phone Number question | 03 | the typed question display vocabulary (`fieldDisplay.ts::FIELD_DISPLAY_SETTINGS`, the one `appearance` writer `xform/appearance.ts`) and its first member, a Text question with `keypad: "numbers"`; the platform row `number-keypad`; the picker entry and the switch; Preview's rule `numberKeypad`; the `keypad` input (part 03, sections 2, 3, 9.1) | none | `questions/phone-number-xsd-string-appearance-numeric` HELD-NEW to HELD; corpus gains `targeted-number-keypad` | `.a6` | whole lane; six lanes a push | part 03's "Tests" for A6, `number-keypad.spec.ts`, `preview-platforms.spec.ts`; **G5** by hand, its outcome written into A6 before the stack merges |
| A7 | A calculated value in prose | 03 | the prose part `{ kind: "value", expression }` on a field's five prose slots; one canonical form; the check by the slot's own profile; `<output value vellum:value>`; `counted` in validation message composition; Preview, translations, the chip and popover, `{{= formula}}`; and literal label text CommCare HQ's build would read as an instance, split by a literal output (`lib/commcare/hqInstanceScan.ts`) (part 03, sections 4, 5, 9.2) | none | `questions/output-value-any-other-expression` HELD-NEW to HELD; one REFUSED entry more under G1's outcome B and one under G3's outcome C, each with its exported predicate, which B6 claims by; corpus gains `targeted-prose-value` | `.a7`; `scripts/test-schema.ts` gains `setFormSections` (64 entries) | whole lane; five lanes a push | part 03's "Tests" for A7, `prose-references.spec.ts`; **G1** (proof 4 in its own CI, once by hand with the editors), **G2**, **G3** in its own CI. Before A7 opens its implementer files the Connect text issue of section 3, rule 12 |
| A8 | Text and lists | 03 | a search with no title, `searchScreenTitle: { kind: "none" }`; a sort rule's `blanks`; `plainHelp`; no formatted copy on a hint or a validation message in any form of any app; `Form.plainText`; Preview's rule `plainHelp`; the four inputs (part 03, sections 6, 7, 8, 9.3) | none | three entries HELD-NEW to HELD, one HELD to INERT, two new (one HELD, one INERT), five re-worded, one ambient line removed; the spelling rule `hint-validation-markdown-form` with its proof; corpus gains three targeted documents, and every document holding a hint or a validation message re-emits | `.a8` | whole lane; four lanes a push | part 03's "Tests" for A8, `text-and-lists.spec.ts`; the corpus emission at base and head; **G4** by hand, its outcome written into A8 before the stack merges |
| A9 | Identifier grammars | 04 | all forty-five `widen` rows decided: nine built (hyphens in question ids with three derivations made injective, the case type grammar and the five reserved words no longer refused, `#record/<type>/<property>`, a case write's property at the catalog grammar, a select with one option and a choice value with one kind of quote mark, hyphens in a Search field's name, in a lookup tag and column name, and in a Connect block id), eighteen split with a step 7 owner, eighteen answered by A2, A3 and A5; `widen` leaves `slotChangeSchema` (part 04, sections 2 to 13) | `20261113000000_hq_round_trip_lookup_names` | sixteen entries edited in place and the twelve other rows of its section 2.2 re-cut, twenty-four new (N1 REFUSED, N2 to N24 HELD-NEW); `SUBJECTS` gains `case-types`; one lane reader; corpus gains eight targeted documents and the names fuzz sample | `.a9`; `RUNTIME_VERSION` 19 | whole lane; three lanes a push | part 04's T1 to T29, `names.spec.ts`; the corpus emission at base and head; **R1** as its first step; **R2**, two dispatches by hand. A9 does not merge until both have run |
| A10 | Agent | 15 | section 13: the `scripts/test-schema.ts` prompts of the entries stack A gave a new input and the header's names; the guide read whole; the one billed check of stack A | none | none | `.a10` only under H1's outcome B; otherwise the stack deploys `.a9` | whole lane; two lanes a push | the hash run at `main` and at this head names the moved tools; **H1**, asked once; **H4** |
| A11 | Contracts and public docs for stack A | 15 | section 14: the texts of `docs/architecture/complex-apps.md` for parts 02, 03 and 04, and ten public pages' sentences | none | none | none | whole lane; one lane a push | the docs build; **H2**, **H3** |

Stack A adds twenty corpus documents and the names sample (twenty-one documents under part 02's G6
outcome B): one base (A1), `targeted-kept-values` (A3), four (A4), one (A5), one (A6), one (A7),
three (A8) and eight (A9). It adds one ledgered migration (A9), moves `MODEL_CONTEXT_VERSION` in A4
to A9 and `RUNTIME_VERSION` in A9, and takes `scripts/test-schema.ts` from 63 entries to 64, or to
64 and one more for each Solutions Architect tool a hash run of A6 to A9 names that the script does
not register (part 03, section 9; expected: none but `setFormSections`). Neither register gains or
loses an entry, and no walk stop is registered but by P1's outcome W.

### 1.2 Stack B, "Bring in"

| # | Title | Parts | Contains | Migration | Manifest, registers, corpus | Versions | Lane | Checks and runs |
|---|---|---|---|---|---|---|---|---|
| B1 | HQ reads | 05, 01 | `readHqJson` telling five failed answers apart; one 429 retry rule, deadlines and byte bounds; the one failure classification `classifyHqFailure` and `hqReadCircumstance`; `listHqApps`, `probeHqApiAccess`, `readHqApplication` (`listAppBuilds` removed); the widened source read; the bracketed read `readHqAppForReading`; `readHqMediaFile`; the lookup and place reads on a caller's deadline; the credential renames; the four status ladders moved onto the classification (part 05, sections 2 to 12) | none | no authored entry; `surface.json` regenerated (`hq-api:FixtureResource` in, `hq-api:LookupTableItemResource` out); seven circumstance codes with their copy (27); the retained group `proof/hq-reads/reading/`, its requests in `proof/views/reading_reads.py`, outside the observation partition | none | package groups and the judges it changes | part 05's "Tests"; **G1 to G7** by hand through `proof-slice.yml`, on B1's branch before it opens |
| B2 | The reader's frame | 06, 01, 08, 10, 12 | `lib/commcare/reader/` with the one pure `readHqApp`; the manifest at run time (`surface/inventory.ts`) and `surface/revision.ts::surfaceStandingsRevision`; the accounting cursor, the claim log and hand-offs; findings and places; the application walker; menus and forms at their own keys with identity before any mint; the provisional document; `assembleDocument`; `planDeclarationChoices`; the carried files `reader/identity.ts` (part 10), `pendingExpressions.ts`, `syntaxCompare.ts` and `hqInterpolation.ts` (part 08); `lib/commcare/xmlNamespaces.ts` (part 06, sections 2 to 7, 16) | none | one new HELD-NEW language entry and one re-wording; part 01's three generated-key entries, its re-wording and the subject `translation-overrides`; the circumstance `no-platform-runs-everything` (28); `circumstanceNext` and `ACCOUNT_CHECK_AGAIN_LINE`; `place-vectors.json` with its Python test | none | package groups and the judges it changes | part 06's B2 tests (`claimsBindManifest.test.ts`, `onePass.test.ts`, `readerPurity.test.ts` among them). The reader has no caller until B10, and every real app reads to an account here |
| B3 | The reader: forms | 06, 01, 03, 09 | the twenty files of `reader/xform/`: parse, the join, the field kind table, appearances, choices, groups, sections, repeats, logic as pending expressions, defaults and A's load-time order, a Hidden Value's bind type, itext by reference, prose, formatted copies, a translation left blank, media references, the generated-node recognizer, Vellum shadows, Connect blocks; emitter exports with no byte change; `tryParseXml`'s failure kind; the `scale` Vitest project and `reader-scale.yml` (part 06, sections 8 to 15) | none | ten new entries and two re-cuts (`questions/question-id-case-registration-script` HELD to HELD-NEW; `questions/an-explicitly-blank-value-in-a-non-default-language-where-the` REFUSED to HELD, part 09's Departure 21); part 01's media wording; three finding sentences | none | package groups and the judges it changes | part 06's B3 tests; **R1** in its own CI; **R2** by hand through `reader-scale.yml` |
| B4 | The reader: case management, menus and links | 07, 01, 02 | `reader/caseManagement/` and `reader/menus/`, each in two passes: a form's type, basic actions, advanced forms, Save to Case blocks in Nova's own shape, `case_references_data.save`, `publishedCaseBlocks` extended and `hq/entryFacts.ts` with `compareEntryFacts`, the case catalog, menus, registration from the case list and the folded hidden menu, after-submit read in reverse with the otherwise and the held-case guards stripped, deep links (part 07, sections 3 to 10) | none | fourteen new entries and part 02's four; two entries HELD-NEW to HELD and one REFUSED to HELD-NEW; six re-cuts without a flip; two lane readers; the subject `advanced-menus` and four sentences; three rows of `READER_CANONICAL_CHOICES` | none | package groups and the judges it changes | part 07's B4 tests; **G4** in its own CI. B4 does not merge with an unequal entry-fact list |
| B5 | The reader: case lists and search | 07, 02, 03 | `reader/caseList/` and `reader/search/`: the two details read into one set of columns, each column by format, sort through the inverse of `caseListOrderPlan`, tiles, the workflow from three booleans, Search fields at pass 1, default filters by property, settings; the reader-declared catalog types (part 07, sections 11, 12) | none | ten new entries, part 02's `case-search/search-on-a-put-in-root-module` and part 03's `case-search/title-label-blank-in-some-languages`; `menus-and-case-lists/6-late-flag-late-flag-1` HELD to HELD-NEW and `case-search/several-xpath-query-rows` HELD-NEW to HELD; four re-cuts; the subject `list-and-search-filters`; two canonical rows | none | package groups and the judges it changes | part 07's B5 tests; **G2** in its own CI |
| B6 | The reader: expressions | 08, 06, 07, 11 | the one recognition method (bind HQ's text under `FormParseScope.reading`, print the candidate with the production emitter, compare two `FormSyntax` trees); folds as proposals; `readExpressions` run twice by `bindExpressions`; the CSQL reader for `_xpath_query` rows; `list(...)` read and kept; `recordDialectRoundTrip`; the finding mapping; `lib/commcare/emissionRewrites.ts` with eight expression entries and the emitter's switch; `settleSearches` and `search/rows.ts` (part 07); `worldEntities.ts::worldEntitiesFromReads` (part 11); one guide sentence (part 08, sections 2 to 11) | none | seven new entries (M1, M2, M5 REFUSED; M3, M4, M6, M7 HELD-NEW), two re-cut, five re-worded; under part 03's G1 outcome B or G3 outcome C (second case), the claim of the REFUSED entry A7 added, made in the prose slot row by A7's predicate (part 08, sections 9.1, 9.2); one finding sentence; `ReaderSpellingRuntimeTest`, `test_csql_reader_parity.py` and new native cases | `.b6` | package groups, the `expression` and `csql` families, the judges it changes | part 08's "Tests"; **E1 to E5** in its own CI. From B6 a plain app reads clean |
| B8 | Identity and the ledger | 10, 01, 09, 14 | `externalIdentityMap`; dense identity rows for an adopted deployment, with `app_deployment_identities` moved to runtime insert-and-delete; `app_deployment_media_paths` and `heldPaths`; the claim (`claimHqAppInTransaction`, the partial unique index, `restoreApp` settling released claims, `readHqAppClaims`); the adopted ledger at birth (`recordAdoptedDeploymentInTransaction`, baseline origin `read`, `languageNames` and `seeds`, plan-feature confirmations at adoption); four changes to `publishAppToHq`; ending a deployment (`ended`, `stopPublishing`, the `expectedEndings` fence); drift wording by `DriftReference`; the baseline identity map; part 01's two overlay rules and fiftieth kept row; part 09's column, with no writer and no reader yet (part 10, sections 2 to 11) | `20261201000000_hq_bring_in_ledger` | `application-and-settings/translations-lang-code-any-other-value-or-absent-where-hq-s` HELD-NEW to TARGET-OWNED; the subject `language-display-names` leaves; the capture's ledger for an HQ-made A takes origin `read`, so `hq-plain` re-emits | none: the two served enums it widens belong to tools MCP alone serves | package groups, the judges it changes, `hq-plain` | part 10's "Tests" (`hqBringInLedger.postgres.test.ts`, `hqAppClaims.postgres.test.ts`, `adoptedLedger.postgres.test.ts`, `endDeployment.postgres.test.ts` among them), `publishing.spec.ts`; **G1**, the person's read-only scan, before it merges |
| B9 | Project data | 11, 01, 06, 09, 10, 14 | media: which files, the fetch, sniff then name, verdicts to findings, staging with no asset row, a reference with no file judged by slot, kind and platform, publication as ready rows before the birth; lookup tables: only the tables the app reads, each a copy managed in CommCare HQ, the writer's purpose and the refusal `managed_in_hq`, a tag that meets a Project table, the `managed-data` preflight, **Manage in Nova**, the hand-back, **Refresh**, ownership derived from sibling apps' live mappings; places as a managed copy with `hq_location_id`; the table page, Organization and Files; two tool descriptions and one guide sentence; the review's types and the three exports acceptance reads (part 11, sections 2 to 14) | `20261202000000_hq_bring_in_project_data` | `expressions-and-data/media-path-jr-file` HELD-NEW to HELD; one entry HELD-NEW to INERT with a REFUSED entry split from it; one re-worded; six circumstance codes (34); corpus gains `targeted-missing-media`; the capture's peer answers the managed-table reads | `.b9`; `scripts/test-schema.ts` gains `getOrganization` (65 entries) | package groups, the judges it changes, `hq-plain`, `targeted-missing-media` | part 11's "Tests", `managed-project-data.spec.ts`; **R1** in its own lane run; **R2** by hand through `proof-slice.yml` |
| B7 | Acceptance and the first-publish register | 09, 14, 15 | the pure `acceptReading` with its five ordered checks; `hq/sourceIdentity.ts` and the port of HQ's question type lookup; `reader/canon.ts::CANONICALIZATIONS` (sixteen rows) and the one read-back comparison `readBackDifferences`; fifteen more `EMISSION_REWRITES` entries and `ExpandOptions.rewrites`; the closed register `FIRST_PUBLISH_CHANGES` (thirty-four entries, two more gated) with its sentences and the one renderer `firstPublishLines`; the writer and readers of `app_deployment_baselines.first_publish_changes` and the rule `firstPublishOf`; the signature of a failed acceptance; `lib/export/boundaryFindings.ts`; `compileCczParts`; `adoptionExportBoundary` (part 09, sections 2 to 15). Row 16 of the register holds the two search text paths of section 12.3 here | none: the column is B8's | no manifest entry; `proof/first-publish-changes.json` completed to every entry in registry order with its `source` rows, `CANDIDATE_IDS` deleted, the file's one Vitest; `reading/question-type-rows.json` | none | package groups and the judges it changes | part 09's "Tests"; **K1** in its own CI; **K2** by hand through `proof-slice.yml`; **K4** by hand through `reader-scale.yml` |
| B10 | The reading and the birth | 12, 01 | the durable `hq_app_readings` row; the service `lib/deployment/reading/` advancing it by bounded, idempotent steps compared by revision; the read step, the media step, check again, remove; six routes under `/api/commcare/readings`; the review and its digest; creation; the `hq-adoption` birth `adoptHqAppInTransaction` through the genesis writer's new seam `afterAppInsert`; the receipt's adoption arm; the census and `scripts/inspect-hq-readings.ts`; the worker bundle for the check, run under its own heap limit, with a check past its time or its memory answered `too-large`; one step budget of 270 seconds for every caller; the instance's one reading slot; the mark a running step writes (`step_beat_at`), by which a page decides whether to drive; `--memory=2Gi` named on the `deploy` step (part 12, sections 2 to 10) | `20261203000000_hq_app_readings` | none; the circumstance `could-not-create` and a widened `too-large` (35) | none | package groups and the judges it changes | part 12's "Tests" (`birth.postgres.test.ts`, `createDigest.postgres.test.ts`, `routes.test.ts` among them); **M1**, by hand through `reader-scale.yml` on B10's branch |
| B11 | The experience | 13 | three entries to `/build/new?hq=choose`; the flow as a state of `/build/new`; the picker over `GET /api/commcare/hq-apps`; the connection aside and `GET /api/commcare/connection`; the reading, stop, account, review, creating and landing screens; the home section "Coming in from CommCare HQ"; the Publishing card's additions, the first-publish section of the Publish dialog, **Stop publishing here**, the drift stop's third way, the restore toast; the primitive `radio-group`; `design/readme.md`'s "Bringing in" (part 13, sections 2 to 13, 17.4) | none | none | none | package groups and the judges it changes | part 13's B11 tests; `e2e/tests/browser/bring-in.spec.ts`, `e2e/tests/app/bring-in.spec.ts`, `publishing.spec.ts`, run locally one at a time before the push |
| B12 | MCP, the guide and the billed check | 13, 01, 08, 09, 10, 11, 12 | six tools MCP alone serves (`list_hq_apps`, `read_hq_app`, `bring_in_hq_app`, `stop_publishing`, `refresh_managed_data`, `set_lookup_table_management`); five changed tools; the error shapes; one guide paragraph (part 13, sections 14, 15) | none | none | `.b12`, the value stack B deploys | package groups and the judges it changes | part 13's B12 tests (`servedSchemas.test.ts`, `bringInTools.postgres.test.ts`); **E1**, asked once as B12's first act; the plugin's pull request is opened beside it |
| B13 | Proof at full | 14, 07 | twenty-one more bases and every variant; `targeted-save-to-case-shapes`; the read arm of emission (`readForLane`) for every base; a base's tables and places; the reader bundle `proof/reader/` as the native product `native/reader/`; proof 6; parity; the `source` comparison and the `changes` judge's four holds; thirteen HELD-NEW value-class readers; the spelling rule `field-list-appearance-case`; the synthetic `schema:` layer, the exemptions and the coverage test; the Vitest suites over retained answers; `proof/corpus/hq/` removed; the weekly pin job `retained`; part 05's reads moved into `proof/hq/operations.py` (part 14, sections 2, 4 to 10, 13, 14) | none | no entry of its own; the first-publish file's remaining rows and every `bases`; corpus gains twenty-one bases and `targeted-save-to-case-shapes`; every part key moves | none | whole lane; a push here starts three lanes | part 14's section 10 suites, `entryCoverage.test.ts`; **P3**, **P5**, **P6**, **P8** and part 07's **G1** in its own CI; **P2** (two dispatches, with part 07's G3, part 08's E6, part 10's G2, part 09's K3 and part 01's Run 3 inside it) and **P4** by hand |
| B14 | Contracts and public docs for stack B | 15 | section 15: the root `CLAUDE.md`, `docs/architecture/contracts.md`, `complex-apps.md`, `deployment.md` and `multilingual-localization.md`; one new public page, `meta.json` and eleven pages' sentences; the plans `README.md`'s "proofs 1 to 6" | none | none | none | whole lane; two lanes a push | the docs build; **H3**, **H5** |
| B15 | Removal of this plan | 15 | section 16: the plan and its parts and `scripts/scan-hq-app-claims.ts` leave; "Step 6 is done" | none | none | none | whole lane; one lane a push | no file names the plan; **H7** after the merge |

Stack B adds twenty-three corpus documents (the twenty-one bases, `targeted-missing-media` in B9
and `targeted-save-to-case-shapes` in B13), for 473 at its head by part 14's count (section 12.1).
It adds three ledgered migrations (B8, B9, B10, which sort in that order), moves
`MODEL_CONTEXT_VERSION` in B6, B9 and B12, leaves `RUNTIME_VERSION` at 19, and takes
`scripts/test-schema.ts` to 65 entries. `READ_CIRCUMSTANCES` goes 20 (A2), 27 (B1), 28 (B2), 34
(B9), 35 (B10), less one for each of part 05's G2 outcome C and G7 outcome B. Neither register gains
or loses an entry in either stack, `OPEN_DEFECTS` stays `{}`, and `proof6`, `parity`, `source` and
`changes` take no known-defect entry: `proof/checks/registers.py` refuses one (part 14, section
11.3).

### 1.3 What every pull request of either stack does

- **It is green at its own head.** Each pull request passes the repository's checks and its own lane
  at its head, never only the stack's. A manifest entry flips in the pull request whose code first
  makes the new wording true: an emission-side re-cut in stack A, a reading re-cut in the stack B
  pull request whose reader first claims it (part 01, section 3), with its inventory row under
  `docs/research/2026-09-26-hq-round-trip/inventory/` in the same pull request.
- **A stored-shape change lands only where stated, and every one is optional or a wider grammar.**
  `Module.formsInMenuAbove` (A4); the `always` arm of `Module.caseListRegistrationForm` (A5);
  `keypad` on a Text question (A6); the prose part `value` (A7); the `none` arm of
  `searchScreenTitle`, a sort rule's `blanks`, `plainHelp` and `Form.plainText` (A8); the grammars of
  A9. Stack B adds no document slot at all. Database shapes move only through the four ledgered
  migrations, and the App Test runtime only behind `RUNTIME_VERSION` 19 (A9).
- **A served-schema change is found by hash.** Every pull request runs `npx tsx
  --conditions=react-server scripts/inspect-tool-schema-hashes.ts` at its base and head (free, no
  network) and records in its description the tools whose hash moved. A tool the Solutions Architect
  is given whose description or projected schema moves, and that `scripts/test-schema.ts` does not
  register, is registered by that pull request. No pull request runs the billed check but A10 and
  B12.
- **`MODEL_CONTEXT_VERSION` moves in each pull request that changes a served tool's name,
  description or input schema, or the guide** (`lib/agent/authoring/reference.ts`), as
  `lib/agent/CLAUDE.md` binds, each to a distinct literal
  `"v7-hq-round-trip-bring-in.<pull request id in lower case>"`. A tool MCP alone serves moves
  nothing, and neither does a field added to a read's result.
- **A validator narrowing runs the corpus emission first** (no Docker, `--jobs 2`) at base and head,
  and compares the stop, the census, `index.json`'s document ids and the `(document, code, location)`
  finding multiset: A4 (the forms-in-the-menu-above rules), A5 (`several-registrations`), A8 (the
  schema refusal of a `blanks` equal to the direction's own) and A9 (the removed codes and the
  widened patterns: the comparison shows that no document gained a finding). A new refusal that
  meets a stored shape stops the pull request, as A5's scan is there to show.
- **A new `/api` route sits under a prefix the proxy already allows.** B10's six routes and B11's
  two are under `/api/commcare`, which `lib/hostnames.ts::HOSTNAME_ALLOWLIST` holds for the main
  host, and part 12's `routes.test.ts` holds both that and their absence on the MCP and docs hosts.
  No other pull request adds a route. One added while implementing takes its allowlist entry in the
  same pull request, or the proxy answers 404 in production while localhost serves it.
- **No public surface names a private HQ flag, an HQ route a caller can use without a credential,
  or a client's app.** `lib/commcare/__tests__/projectSpaceCompatibilityBoundary.test.ts` holds the
  first over `components`, `content/docs`, `lib/deployment`, `lib/mcp`, `lib/publish` and the routes.
  The media read is described nowhere but in the research's own words.
- **No pull request runs a served reader, a lane slice or a billed call on the person's machine or
  without their yes.**

### 1.4 Files, by pull request

This is the list an implementer holds a pull request's diff against. Under each pull request it names
every file the parts' "Files by pull request" sections give it, merged: where two parts list one file
for one pull request it appears once, and a file one part writes for another part's pull request
(B2 carries files of parts 08, 10 and 12, B6 files of parts 06, 07 and 11) is listed under the pull
request it lands in. Paths are written from the repository root. The owning part's own list stays
the authority for what changes inside a file.

Five kinds of file are given once, here. A source file stands for its tests in the `__tests__`
directory beside it unless a test is named. A manifest edit changes its entry under
`lib/commcare/surface/entries/` and its row under `docs/research/2026-09-26-hq-round-trip/inventory/`
together. A pull request that adds a targeted document edits `proof/targeted/index.ts`,
`proof/targeted/expected.ts` and `proof/README.md`, "Targeted documents". A stack pull request
edits `docs/research/2026-09-26-hq-round-trip/harness-findings.md` in one case only: a gated run it
holds gave an outcome other than A, and that outcome corrects a claim the research states under
"Found while planning step 6". Section 8.1 lists every such run with its pull request, its outcome
and the bullet it writes; no list below repeats the file, and no pull request adds a heading or a
bullet there. A `CLAUDE.md` file or a public page is listed under the pull request sections 6 and 7
assign it.

And **every importer of a module or symbol a pull request deletes, moves or renames is re-pointed in
that pull request**, tests, fixtures, scripts, lane producers and comments included. Their list is a
command run at the pull request's base:

```
rg -l -e '<dir>/<name>\b' -e '"\./<name>"' lib app components proof scripts e2e __tests__
rg -l -w -e '<export 1>' -e '<export 2>' lib app components proof scripts e2e __tests__
```

Each hit is read. What step 6 deletes, moves or renames: `previewMenuModuleUuids` (A4);
`caseListRegistrationFormOf` to `afterEmptySearchRegistrationFormOf` and `caseListFormReturnFrame` to
`caseListFormReturnFrames` (A5); `lib/commcare/xform/proseExpression.ts`, whose
`proseReferenceExpression` moves to `lib/domain/proseExpression.ts`, and the export
`lib/agent/authoring/text.ts::textSchema` (A7); `lib/commcare/validator/reservedNamespaces.ts`,
`SELECT_TOO_FEW_OPTIONS` and `lib/references/config.ts::namespaceOf` (A9); `client.ts::listAppBuilds`,
`resolveUploadDomain` to `resolveHqDomain`, the two renamed functions of `lib/db/settings.ts`, and
`readBoundedBody` to `lib/commcare/hq/readBody.ts` (B1); the namespace helpers of
`hq/publishedCaseBlocks.ts` to `lib/commcare/xmlNamespaces.ts` (B2); `isConsumerWhitespace` to
`lib/commcare/xform/consumerWhitespace.ts` (B3); `REWRITE_SENTENCES`, `CANDIDATE_IDS`, and
`lookupExportFindings`, `organizationExportFindings` and `LookupRowVerdictInput` to
`lib/export/boundaryFindings.ts` (B7); `MEDIA_INSTALL_PATH` (B8); `recoverFailedMcpPublication` and
`withUploadPermission` into `lib/media/publishReadyMedia.ts` (B9); `publishPlanCopy`, `PublishPlan`
and the private `NotConfigured` (B11); `proof/corpus/hq/`, `proof/views/reading_reads.py` and
`proof/corpus/hq/test_privileges.py` to `proof/hq/test_privilege_rules.py` (B13).

#### A1: Lane groundwork and the probe base (part 14, "Files by pull request")

- New: `proof/matrix/__init__.py`, `registry.py`, `author.py`, `retain.py`, `retained.py` (`Retained`,
  moved out of `proof/hq/test_retained_reads.py`), `seed.py`, `ops.py`, `adopt.py`, `bases/__init__.py`,
  `bases/plain.py`, `conftest.py`, `test_retained.py`, `test_remade.py`, `test_seed.py`,
  `test_expectations.py`; `proof/matrix/hand/hq-plain/document.ts`, `edit.ts`, `expectations.json`,
  `restore.xml`; `proof/hq-apps/hq-plain/` (`base.json`, `app.json`, `media.json`, `app-source.json`,
  `seed.json`); `proof/corpus/hqAuthored.ts`; `proof/first-publish-changes.json`;
  `proof/checks/changes.py`
- Changed, the corpus: `proof/corpus/documents.ts`, `entryWriter.ts`, `emitCorpus.ts`, `inputs.ts`,
  `publish.ts` (`hqAuthoredA`), `targetPeer.ts` (`holdSource`),
  `proof/corpus/__tests__/publish.postgres.test.ts`, `emitCorpus.test.ts`
- Changed, the observation: `proof/hq/operations.py` (`save_authored_app`),
  `proof/hq/test_retained_reads.py`, `proof/observe/publish.py`, `unit.py`, `intent.py`, `casedata.py`
- Changed, the judges: `proof/checks/corpus.py`, `configurations.py`, `eligibility.py`, `intent.py`,
  `proof1.py`, `proof2.py`, `proof3.py`, `registers.py`, `test_corpus.py`, `test_intent.py`,
  `test_build_files.py`, `test_registers.py`, `sharding.py`; `proof/store/fingerprints.py`
- `biome.json` (`proof/hq-apps` joins the ignore list)
- Docs: `proof/README.md`, `proof/CLAUDE.md`, the root `CLAUDE.md` (the `proof/` bullet, section 6.2)
- Only under P1's outcome: `proof/rules/<rule>.py` with its test (S), a member of `HQ_OWN_REPORTS` (H),
  an entry of `proof/walk-stops.json` (W)

#### A2: Manifest schema and the emission-side re-cuts (part 01, "Files by pull request", A2)

- New: `lib/publish/hqFindings.ts`, `lib/publish/hqFindingCopy.ts`, `lib/commcare/surface/standing.ts`;
  `lib/commcare/surface/__tests__/standing.test.ts`, `lib/publish/__tests__/hqFindings.test.ts`,
  `hqFindingCopy.test.ts`
- Changed: `lib/commcare/surface/schema.ts`, `lib/commcare/surface/__tests__/manifest.test.ts`,
  `lib/commcare/surface/entries/*.json` (every area file, and `gates.json` for the cell of section 8.3
  here)
- Inventory: `menus-and-case-lists.md`, `application-and-settings.md`, `case-search.md`,
  `forms-and-case-writes.md` (the `xmlns` row, in part 10's words), `questions.md`,
  `expressions-and-data.md`, `gates.md`
- Docs: `lib/commcare/CLAUDE.md`

#### A3: Kept at CommCare HQ's value (part 01, "Files by pull request", A3)

- New: `lib/commcare/surface/keptAtHq.ts`, `lib/commcare/targetFacts.ts`, `lib/commcare/keptProfile.ts`,
  `lib/deployment/targetFacts.ts`, `lib/publish/keptValues.ts`, `lib/preview/listFilterMatch.ts`,
  `lib/collab/previewTargetFactsFrame.ts`, `e2e/tests/app/preview-kept.spec.ts`,
  `e2e/lib/keptBaselineSeed.ts`
- Changed, the manifest: `lib/commcare/surface/entries/application-and-settings.json`,
  `forms-and-case-writes.json`, `lib/commcare/surface/platformFeatureEntries.ts`,
  `lib/preview/__tests__/platformCells.ts`, `lib/publish/hqFindingCopy.ts`
- Changed, the archive: `lib/commcare/appStringKeys.ts`, `compiler.ts`, `runtimeTarget.ts`,
  `appProfileSettings.ts` (header), `lib/deployment/store.ts`, `types.ts`, `downloadTarget.ts`,
  `lib/export/localArchive.ts`, `app/api/compile/route.ts`, `app/api/compile/json/route.ts`,
  `app/api/compile/prepareCompileRequest.ts`, `lib/mcp/tools/compileApp.ts`, `proof/corpus/publish.ts`,
  `lib/publish/exportAdvisories.ts`
- Changed, Preview: `lib/preview/platform.ts`, `components/preview/shared/listFilter.tsx`,
  `components/preview/screens/CaseListScreen.tsx`, `lib/deployment/previewTarget.ts`, `previewSpace.ts`,
  `lib/collab/ReconcilerProvider.tsx`, `context.ts`, `components/builder/DeploymentTargetProvider.tsx`,
  `BuilderProvider.tsx`, `app/(app)/build/[id]/[[...path]]/page.tsx`, `app/api/apps/[id]/stream/route.ts`
- Changed, the card and MCP: `lib/deployment/service.ts`, `actions.ts`,
  `app/api/commcare/upload/route.ts`, `components/builder/publishOutcome.ts`, `PublishDialogBody.tsx`,
  `DeploymentStatus.tsx`, `app-setup/PublishingSection.tsx`, `lib/mcp/tools/deploymentTools.ts`,
  `deploymentProjection.ts`
- Tests named outright: part 01's section 10, A3 table (twelve new files, five extended)
- Docs: `lib/commcare/CLAUDE.md`, `lib/export/CLAUDE.md`, `lib/deployment/CLAUDE.md`,
  `lib/preview/CLAUDE.md`, `components/builder/CLAUDE.md`, `docs/architecture/contracts.md`,
  `content/docs/publishing.mdx`, `building-with-nova.mdx`, `mcp/tools.mdx`; inventory
  `application-and-settings.md`

#### A4: Display-only forms (part 02, "Files by pull request", A4)

- New: `lib/domain/menuScreens.ts`, `lib/commcare/validator/rules/formsInMenuAbove.ts`,
  `components/builder/detail/moduleSettings/MenuScreenSection.tsx`,
  `lib/commcare/__tests__/menuScreenDocArbitrary.ts`, `e2e/tests/app/menu-above.spec.ts`
- Domain: `lib/domain/modules.ts`, `index.ts`, `menuForms.ts`, `forms.ts`, `postSubmit.ts`,
  `formLinkTargets.ts`, `navigation.ts`, `entryDatumSupplies.ts`, `expression/context.ts`,
  `referenceSlots.ts`
- Wire: `lib/commcare/expander.ts`, `addOns.ts`, `compiler.ts`, `formLinkProjection.ts`,
  `previousTaskProjection.ts`, `multimedia/navMenuMedia.ts`, `xpath/wire/builders.ts`, `serialize.ts`,
  `precedence.ts`, `validator/suiteOracle.ts`, `errors.ts`, `gate.ts`, `runner.ts`, `rules/module.ts`,
  `rules/form.ts`, `rules/app.ts`, `rules/displayConditions.ts`
- Doc: `lib/doc/displayConditionMutations.ts`, `incrementalValidationScope.ts`,
  `formLinkTargetChoices.ts`, `formLinkReview.ts`, `entryPointReview.ts`, `userFacingErrors.ts`,
  `hooks/useModuleIds.ts`
- Preview: `lib/preview/menuProjection.ts`, `afterSubmitRouting.ts`, `entryPointLaunch.ts`,
  `hooks/usePreviewScreenForLocation.ts`, `app-tests/navigation.ts`, `app-tests/actions.ts`,
  `engine/postSubmissionEvaluation.ts`, `components/preview/screens/HomeScreen.tsx`, `ModuleScreen.tsx`,
  `CaseListScreen.tsx`, `FormScreen.tsx`
- Builder: `components/builder/detail/moduleSettings/ModuleSettingsPanel.tsx`, `ModuleNameSection.tsx`,
  `ModuleAppearanceSection.tsx`, `appTree/ModuleCard.tsx`, `conditions/displayConditionCopy.ts`,
  `useDisplayConditionCarrier.ts`, `detail/formSettings/AfterSubmitSection.tsx`,
  `form-links/LinkTargetPicker.tsx`
- Agent: `lib/agent/tools/updateModule.ts`, `getModule.ts`, `form-links/shared.ts`,
  `summarizeBlueprint.ts`, `authoring/reference.ts`, `lib/models.ts`
- Manifest and lane: `lib/commcare/surface/entries/menus-and-case-lists.json`,
  `application-and-settings.json`, `lib/publish/hqFindingCopy.ts`,
  `proof/checks/manifest_value_classes.py`, `test_manifest_value_classes.py`,
  `proof/targeted/documents/formsInMenuAbove.ts`, `formsInMenuAboveNested.ts`,
  `formsInMenuAbovePrefixes.ts`, `proof/native/producers/emit-menu-screens-evidence.ts`,
  `proof/native/test_menu_above_emission.py`, `proof/native/core/MenuScreensRuntimeTest.java`,
  `proof/native/families.py`, `proof/corpus/editKinds.ts`
- Tests named outright: part 02's "Tests", A4 (nine new files, five extended)
- Docs: `lib/domain/CLAUDE.md`, `lib/commcare/CLAUDE.md`, `lib/doc/CLAUDE.md`, `lib/preview/CLAUDE.md`,
  `components/builder/CLAUDE.md`

#### A5: Registration from the case list, always offered (part 02, "Files by pull request", A5)

- New: `lib/doc/alwaysOfferedRegistration.ts`, `caseListRegistrationDependents.ts`,
  `lib/agent/tools/shared/registerFromCaseList.ts`,
  `components/builder/case-list-config/canvas/RegisterFromListSetting.tsx`,
  `proof/targeted/documents/registerFromCaseList.ts`, `proof/native/test_register_from_list_emission.py`,
  `proof/native/core/RegisterFromListRuntimeTest.java`, `e2e/tests/app/register-from-list.spec.ts`,
  `scripts/scan-case-list-registration-registrations.ts` (removed in the last commit of A5's pull
  request, made after its run and before stack A merges)
- Only where the scan finds an app and the person says yes for it (section 5.3):
  `scripts/migrate-case-list-registration-registrations.ts` with
  `scripts/lib/caseListRegistrationRepair.ts` and its Postgres test, the two bundle lines of the
  `Dockerfile`'s `maintenance-build` stage, the two arms of `scripts/rollout/deploy-cloud-run.py` with
  their cases in `scripts/infra/tests/test_deployment_policy.py`, and one paragraph of
  `docs/architecture/deployment.md`, "Historical repairs"; every one of them removed in that same last
  commit of A5's pull request, after the run
- Domain: `lib/domain/modules.ts`, `menuForms.ts`, `navigation.ts`, `mediaRefs.ts`, `referenceSlots.ts`,
  `platforms.ts`, `platformUses.ts`, `translationUnits.ts`, `expression/context.ts`
- The renamed reader's other sites: `lib/commcare/entryPointProjection.ts`, `emissionPlan.ts`,
  `lib/doc/entryPointReview.ts`, `searchReadDependents.ts`, `caseListRegistrationForm.ts`,
  `hooks/useModuleIds.ts`, `hooks/useOfferedBatchRefusals.ts`, `lib/agent/tools/updateForm.ts`,
  `createForm.ts`, `authoring/formPreparation.ts`,
  `components/builder/case-list-config/caseListRegistrationReview.tsx`,
  `canvas/CaseListRegistrationSetting.tsx`, `detail/formSettings/NoMatchesAfterSubmitSection.tsx`
- Wire: `lib/commcare/expander.ts`, `types.ts`, `compiler.ts`, `suite/case-list/shortDetail.ts`,
  `multimedia/navMenuMedia.ts`, `formLinkProjection.ts`, `session.ts`, `projectSpaceCompatibility.ts`,
  `validator/rules/case-search/caseListRegistration.ts`, `rules/app.ts`, `rules/form.ts`,
  `validator/runner.ts`, `errors.ts`, `gate.ts`, `surface/platformFeatureEntries.ts`
- Doc: `lib/doc/mutations/forms.ts`, `mutations/modules.ts`, `mutations/notify.ts`,
  `incrementalValidationScope.ts`, `userFacingErrors.ts`, `hooks/useBlueprintMutations.ts`
- Preview: `lib/preview/caseListRegistration.ts`, `platform.ts`, `app-tests/records.ts`, `run.ts`,
  `types.ts`, `submission.ts`, `lib/session/types.ts`, `components/preview/screens/CaseListScreen.tsx`,
  `FormScreen.tsx`, `lib/preview/__tests__/platformCells.ts`, `platformCellModels.ts`
- Builder: `components/builder/case-list-config/canvas/CaseListCanvas.tsx`,
  `detail/formSettings/FormEntrySection.tsx`
- Agent: `lib/agent/tools/updateModule.ts`, `media/setMenuMedia.ts`, `getModule.ts`, `getForm.ts`,
  `removeForm.ts`, `removeModule.ts`, `shared/caseListRegistration.ts`, `summarizeBlueprint.ts`,
  `authoring/reference.ts`, `lib/models.ts`, `scripts/inspect-app.ts`
- Manifest and lane: the entries of part 02's section 14 in `menus-and-case-lists.json`,
  `proof/checks/manifest_value_classes.py`, `test_manifest_value_classes.py`, `proof/native/families.py`,
  `proof/native/producers/emit-menu-screens-evidence.ts`, `proof/corpus/editKinds.ts`
- Tests named outright: part 02's "Tests", A5 (five new files, eight extended)
- Docs: the same five `CLAUDE.md` files, each by its A5 rows

#### A6: The Phone Number question (part 03, "Files by pull request", A6)

- New: `lib/domain/fieldDisplay.ts`, `lib/commcare/xform/appearance.ts`,
  `lib/preview/engine/numberKeypad.ts`, `components/builder/editor/fields/KeypadEditor.tsx`,
  `e2e/tests/app/number-keypad.spec.ts`, the lane document `targeted-number-keypad`
- Changed: `lib/domain/fields/text.ts`, `index.ts`, `referenceSlots.ts`, `platforms.ts`,
  `platformUses.ts`, `__tests__/platformFeatureFixtures.ts`; `lib/commcare/xform/builder.ts`,
  `surface/platformFeatureEntries.ts`, `surface/entries/questions.json`; `lib/preview/platform.ts`,
  `engine/formEngine.ts`, `runtimeMessages.ts`, `__tests__/platformCells.ts`;
  `e2e/lib/previewPlatformScenarios.ts`, `preview-platforms-client.tsx`,
  `e2e/tests/browser/preview-platforms.spec.ts`; `proof/android/test_form_reads.py`;
  `components/preview/form/FieldTypePicker.tsx`, `newFieldDefaults.ts`, `fields/TextField.tsx`;
  `components/builder/editor/fieldEditorSchemas.ts`; `lib/agent/toolSchemaGenerator.ts`,
  `contentProcessing.ts`, `tools/editField.ts`, `authoring/output.ts`, `authoring/reference.ts`;
  `lib/models.ts`
- Docs: `lib/domain/CLAUDE.md`, `lib/preview/CLAUDE.md`, `components/builder/CLAUDE.md`

#### A7: A calculated value in prose (part 03, "Files by pull request", A7)

- New: `lib/domain/proseExpression.ts`, `lib/commcare/hqInstanceScan.ts`, `lib/references/ValueChip.tsx`,
  `components/builder/ProseValuePopover.tsx`, `lib/agent/authoring/proseSlots.ts`,
  `proof/hq/test_label_instance_text.py`, `proof/native/core/ProseValueRuntimeTest.java`, the lane
  document `targeted-prose-value`
- Removed: `lib/commcare/xform/proseExpression.ts`; the export `lib/agent/authoring/text.ts::textSchema`
- Changed, domain and doc: `lib/domain/prose.ts`, `blueprint.ts`, `referenceSlots.ts`,
  `expressionSource.ts`, `translationUnits.ts`, `workerRecordRequirements.ts`;
  `lib/doc/referenceIndex.ts`, `mutations/referenceRewrites.ts`, `casePropertyRenames.ts`,
  `caseTypeRetirement.ts`, `formSectionVerdicts.ts`, `expressionText.ts`,
  `projectBuilderLanguageMutations.ts`, `hooks/useXPathSlots.ts`, `hooks/useExpressionSlotContext.ts`,
  and each consumer of part 03's section 4.3 tables
- Changed, wire and Preview: `lib/commcare/validator/index.ts`, `xform/formExpressions.ts`,
  `xform/builder.ts`, `xform/constraintMessage.ts`, `xpath/wire/serialize.ts`, `xpath/formParseScope.ts`,
  `projectSpaceCompatibility.ts`, `surface/entries/questions.json`;
  `lib/codemirror/expressionEditorContext.ts`; `lib/preview/engine/formExpressionRuntime.ts`,
  `labelRefs.ts`, `triggerDag.ts`, `formText.ts`
- Changed, editors: `lib/tiptap/commcareRefNode.ts`, `proseTemplateCodec.ts`, `proseReferenceEditing.ts`,
  `CommcareRefView.tsx`; `lib/references/provider.ts`, `LabelContent.tsx`;
  `components/builder/ProseReferencePicker.tsx`, `RefLabelInput.tsx`,
  `components/preview/form/InlineTextEditor.tsx` and their call sites;
  `components/builder/app-setup/protectedProse.ts`; `e2e/tests/app/prose-references.spec.ts`
- Changed, agent: `lib/agent/authoring/schema.ts`, `text.ts`, `input.ts`, `output.ts`, `reference.ts`,
  `lib/agent/translation/translator.ts`, `tools/localization.ts`, `scripts/test-schema.ts` (the
  `setFormSections` entry, section 13 here), `lib/models.ts`
- Lane: `proof/native/families.py`, `proof/native/producers/emit-expression-evidence.ts`
- Only under a run's outcome: `lib/commcare/validator/rules/field.ts`, `errors.ts`, `gate.ts`,
  `lib/doc/userFacingErrors.ts` and one entry more (G1's outcome B; G3's outcome C, second case);
  `proof/rules/prose_output_spelling.py` with its test (G1's outcome C)
- Docs: `lib/domain/CLAUDE.md`, `lib/domain/expression/CLAUDE.md`, `lib/commcare/CLAUDE.md`,
  `lib/agent/authoring/CLAUDE.md`, `components/builder/CLAUDE.md`

#### A8: Text and lists (part 03, "Files by pull request", A8)

- New: `lib/domain/plainText.ts`, `components/preview/form/useHelpFormatText.ts`,
  `components/builder/case-list-config/sortBlanksChoice.ts`,
  `proof/rules/hint_validation_markdown_form.py`, `proof/rules/test_hint_validation_markdown_form.py`,
  `e2e/tests/app/text-and-lists.spec.ts`, the lane documents `targeted-search-no-title`,
  `targeted-sort-blanks`, `targeted-plain-help`
- Changed, domain and doc: `lib/domain/modules.ts`, `forms.ts`, `fields/base.ts`, `caseListOrder.ts`,
  `translationUnits.ts`, `localizedBlueprintProjection.ts`, `platforms.ts`, `platformUses.ts`,
  `referenceSlots.ts`; `lib/doc/projectBuilderLanguageMutations.ts`
- Changed, wire and Preview: `lib/commcare/hqJson/caseList.ts`, `suite/case-search/searchSession.ts`,
  `xform/builder.ts`, `surface/platformFeatureEntries.ts`, `surface/entries/questions.json`,
  `case-search.json`, `menus-and-case-lists.json`; `lib/preview/platform.ts`, `workerModule.ts`,
  `__tests__/platformCells.ts`; `e2e/lib/previewPlatformScenarios.ts`, `preview-platforms-client.tsx`,
  `e2e/tests/browser/preview-platforms.spec.ts`; `proof/android/test_form_reads.py`
- Changed, editors: `components/preview/screens/CaseListScreen.tsx`, `form/FieldHelp.tsx`,
  `form/formatText.ts`, the choice fields; `lib/references/LabelContent.tsx`;
  `components/builder/case-list-config/inspector/SearchPanelInspectorBody.tsx`,
  `canvas/SearchCanvas.tsx`, `CaseListConfigWorkspace.tsx`, `SortPriorityStack.tsx`;
  `components/builder/editor/fields/TextEditor.tsx`;
  `components/builder/detail/formSettings/FormAppearanceSection.tsx`
- Changed, agent: `lib/agent/toolSchemaGenerator.ts`, `contentProcessing.ts`, `tools/editField.ts`,
  `updateForm.ts`, `createForm.ts`, `tools/case-search-config/shared.ts`,
  `tools/case-list-config/shared.ts` and the column tools that read it, `authoring/output.ts`,
  `authoring/reference.ts`, `lib/models.ts`
- Docs: `lib/domain/CLAUDE.md`, `lib/commcare/CLAUDE.md`, `lib/preview/CLAUDE.md`,
  `components/builder/CLAUDE.md`

#### A9: Identifier grammars (part 04, "Files by pull request")

- Domain: `lib/domain/questionId.ts`, `hashtagSegments.ts`, `expression/types.ts`, `expression/print.ts`,
  `caseOperationIdentifiers.ts`, `standardCaseProperties.ts`, `selectOptionValue.ts`,
  `fields/selectOptionsSource.ts`, `fields/base.ts`, `fields/singleSelect.ts`, `fields/multiSelect.ts`,
  `fields/text.ts`, `modules.ts`, `forms.ts`, `prose.ts`, `index.ts`
- Wire: `lib/commcare/constants.ts`, `xform/formPath.ts`, `xform/itextIds.ts`,
  `xform/caseSaveReferences.ts`, `advancedTags.ts`, `hashtags.ts`, `formActions.ts`, `connectSlugs.ts`,
  `xpath/grammar.lezer.grammar`, `xpath/hashtagGuard.ts`, `xpath/parser.ts` and `parser.terms.ts`
  (regenerated), `xpath/expressionAst.ts`, `validator/reservedNamespaces.ts` (deleted),
  `validator/rules/app.ts`, `rules/module.ts`, `rules/field.ts`, `rules/caseOperations.ts`,
  `validator/errors.ts`, `gate.ts`, `runner.ts`, `validator/formLogicFindings.ts`,
  `suite/case-search/reservedInputNames.ts`, `surface/schema.ts`, the five area files of
  `surface/entries/` and `gates.json`
- Doc, lookup, store and runtime: `lib/doc/identifierVerdicts.ts`, `userFacingErrors.ts`,
  `expressionText.ts`, `types.ts`, `mutations/fields.ts`; `lib/lookup/constants.ts`, `schema.ts`;
  `lib/case-store/migrations/20261113000000_hq_round_trip_lookup_names.ts` (new), `migrations/index.ts`,
  `store.ts`, `postgres/store.ts`; `lib/preview/engine/queryWrapperName.ts`; `lib/db/appTests.ts`;
  `lib/models.ts`
- Agent and editors: `lib/agent/authoring/bindings.ts`, `reference.ts`, `printQueryExpression.ts`,
  `formRecordContext.ts`, `text.ts`, `toolSchemaGenerator.ts`, `tools/case-operations/shared.ts`,
  `tools/setFieldOptionsSource.ts`; `lib/publish/hqFindings.ts`, `hqFindingCopy.ts`;
  `lib/references/config.ts`, `provider.ts`; `lib/tiptap/refSuggestion.ts`;
  `lib/codemirror/xpath-autocomplete.ts`; `components/builder/editor/fields/OptionsEditor.tsx`,
  `OptionsSourceEditor.tsx`, `optionsDraftModel.ts`, `caseWritePresentation.ts`,
  `shared/caseTypePickerModel.ts`, `case-list-config/seeds.ts`, `project-data/projectDataModel.ts`,
  `CreateTableDialog.tsx`, `AddColumnDialog.tsx`
- Lane: `proof/targeted/documents/hyphenatedQuestionIds.ts`, `caseTypeNames.ts`, `choiceValues.ts`,
  `lookupNames.ts`, `searchFieldNames.ts`, `caseWriteNames.ts` (new), `connectApps.ts`,
  `proof/connect/conftest.py`, `proof/checks/manifest_value_classes.py`, `test_manifest_value_classes.py`
- Tests named outright: part 04's T1 to T29, `lib/commcare/__tests__/namesDocArbitrary.ts`, and the three
  suites a removed code leaves false (`validationRules.test.ts`, `multiplayerMerge.test.ts`,
  `caseLoadMetadata.test.ts`)
- Docs: `lib/domain/CLAUDE.md`, `lib/doc/CLAUDE.md`, `lib/commcare/CLAUDE.md`,
  `lib/commcare/xpath/CLAUDE.md`, `lib/lookup/CLAUDE.md`, `lib/preview/app-tests/CLAUDE.md`,
  `components/builder/CLAUDE.md`

#### A10 and A11

Section "Files by pull request", at the end of this part.

#### B1: HQ reads (part 05, "Files by pull request")

- New: `lib/commcare/hq/readBody.ts`, `throttle.ts`, `failure.ts`, `apps.ts`, `application.ts`,
  `appReading.ts`, `media.ts`; `app/(app)/(site)/settings/hqFailureMessage.ts`
- Changed, the client: `lib/commcare/hq/http.ts`, `deadline.ts`, `readJson.ts`, `readCollection.ts`,
  `appSource.ts`, `lookupTables.ts`, `locations.ts`, `lib/commcare/client.ts`
- Changed, its callers: `lib/db/settings.ts`, `domainResolution.ts`;
  `lib/mcp/tools/checkProjectSpaceCompatibility.ts`, `uploadAppToHq.ts`;
  `app/api/commcare/project-space-compatibility/route.ts`; `lib/deployment/service.ts`, `preflight.ts`,
  `entryPointLinks.ts`, `workers.ts`, `observe.ts`, `previewTarget.ts` (a comment);
  `app/(app)/(site)/settings/actions.ts`
- Part 01's lines: `lib/publish/hqFindings.ts`, `hqFindingCopy.ts` (seven circumstance codes and their
  blocks)
- Tests named outright: part 05's "Tests" (eight new files, fifteen changed),
  `__tests__/helpers/retainedHqReads.ts`
- Lane: `proof/views/reading_reads.py` (new), `proof/hq/test_retained_reads.py`,
  `proof/hq-reads/reading/*.json` (new), `proof/surface/families/hq_api.py`,
  `proof/surface/test_hq_api.py`, `lib/commcare/surface/surface.json` (regenerated by `npm run surface`)
- Docs: `lib/commcare/CLAUDE.md`, `lib/deployment/CLAUDE.md`, `proof/README.md`; `harness-findings.md`
  only under the three outcomes section 8.1 lists for B1
- Not edited: `biome.json`, `lib/hostnames.ts`, `proof/hq/operations.py`

#### B2: The reader's frame (part 06, "Files by pull request", B2)

- New, outside the reader: `lib/commcare/xmlNamespaces.ts`, `lib/commcare/surface/inventory.ts`,
  `lib/commcare/surface/revision.ts` (`surfaceStandingsRevision` alone)
- New, `lib/commcare/reader/`: `index.ts`, `types.ts`, `context.ts`, `claims.ts`, `accounting.ts`,
  `jsonCursor.ts`, `xmlCursor.ts`, `place.ts`, `defects.ts`, `appShell.ts`, `languages.ts`,
  `structure.ts`, `translations.ts`, `generatedTranslationKeys.ts`, `assemble.ts`, `provisional.ts`
  (`provisionalDocument` alone), `identity.ts` (part 10's), `pendingExpressions.ts`, `syntaxCompare.ts`,
  `hqInterpolation.ts` with `__tests__/hqInterpolation.test.ts` and `interpolationVectors.ts` (part 08's)
- Changed: `lib/commcare/hq/publishedCaseBlocks.ts`, `lib/commcare/xform/deviceForm.ts` (both import the
  namespace helpers); `lib/commcare/xform/captureUrlNode.ts` and `lib/commcare/xpath/index.ts` (a comment
  each, section 6.5 here); `lib/doc/platformDeclaration.ts` (`planDeclarationChoices`);
  `lib/commcare/surface/entries/application-and-settings.json`; `lib/publish/hqFindings.ts`,
  `hqFindingCopy.ts`, `lib/publish/__tests__/hqFindingCopy.test.ts`
- Lane: `proof/checks/fixtures/place-vectors.json`, `proof/checks/test_place_vectors.py`
- Tests named outright: part 06's "Tests", B2 (nineteen new files), `reader/__tests__/identity.test.ts`
  (part 10's)
- Docs: `lib/commcare/CLAUDE.md`, `lib/doc/CLAUDE.md`
- Not edited: `biome.json`

#### B3: The reader, forms (part 06, "Files by pull request", B3)

- New: the twenty files of `lib/commcare/reader/xform/` (`index.ts`, `claims.ts`, `parse.ts`, `model.ts`,
  `body.ts`, `join.ts`, `kinds.ts`, `appearances.ts`, `options.ts`, `containers.ts`, `repeats.ts`,
  `logic.ts`, `loadOrder.ts`, `itext.ts`, `prose.ts`, `media.ts`, `generated.ts`, `shadow.ts`,
  `connect.ts`, `afterBinding.ts`); `lib/commcare/xform/consumerWhitespace.ts`;
  `.github/workflows/reader-scale.yml`
- Changed: `lib/commcare/reader/index.ts` (`STAGES`), `defects.ts`;
  `lib/commcare/xform/generatedNodes.ts` (`generatedBaseName`), `xform/builder.ts` (exports, no emitted
  byte changes), `lib/commcare/xmlParse.ts`; `vitest.config.mts` (the `scale` project);
  `lib/commcare/surface/entries/questions.json`, `forms-and-case-writes.json`, `gates.json`;
  `lib/publish/hqFindingCopy.ts`
- Tests named outright: part 06's "Tests", B3 (nineteen new files, `readerScale.scale.test.ts` and
  `readerWork.test.ts` among them)
- Docs: `lib/commcare/CLAUDE.md`, `docs/testing.md`

#### B4: The reader, case management, menus and links (part 07, "Files by pull request", B4)

- New: `lib/commcare/reader/caseManagement/index.ts`, `formType.ts`, `conditions.ts`, `basicActions.ts`,
  `preloads.ts`, `advancedActions.ts`, `saveToCase.ts`, `saveToCaseCompare.ts`, `catalog.ts`;
  `lib/commcare/reader/menus/index.ts`, `modules.ts`, `navMedia.ts`, `registration.ts`, `afterSubmit.ts`,
  `entryPoints.ts`; `lib/commcare/reader/candidate.ts`, `projectionInputs.ts`, `hqPageLabels.ts`;
  `lib/commcare/hq/entryFacts.ts`; `lib/commcare/__tests__/formLinkDocArbitrary.ts` (the link generator,
  moved)
- Changed: `lib/commcare/hq/publishedCaseBlocks.ts`, `lib/commcare/expander.ts` (`toHqFormLink`
  exported), `lib/commcare/xform/caseSaveReferences.ts` (`caseSaveReferencesOf`),
  `lib/commcare/reader/types.ts`, `context.ts`, `index.ts`, `assemble.ts`;
  `lib/commcare/surface/entries/forms-and-case-writes.json`, `menus-and-case-lists.json`,
  `questions.json`; `proof/checks/manifest_value_classes.py`, `test_manifest_value_classes.py`;
  `lib/publish/hqFindings.ts`, `hqFindingCopy.ts`
- Tests named outright: part 07's "Tests", B4, `saveToCase.retained.test.ts` with its two
  `targeted-migration-*` cases among them
- Docs: `lib/deployment/CLAUDE.md`, `lib/commcare/CLAUDE.md`

#### B5: The reader, case lists and search (part 07, "Files by pull request", B5)

- New: `lib/commcare/reader/caseList/index.ts`, `columns.ts`, `details.ts`, `order.ts`, `tile.ts`;
  `lib/commcare/reader/search/index.ts`, `workflow.ts`, `prompts.ts`, `settings.ts`
- Changed: `lib/commcare/reader/caseManagement/catalog.ts`, `hqPageLabels.ts`, `index.ts`, `assemble.ts`;
  `lib/commcare/surface/entries/case-search.json`, `menus-and-case-lists.json`;
  `lib/publish/hqFindings.ts`, `hqFindingCopy.ts`
- Tests named outright: part 07's "Tests", B5
- Docs: `lib/commcare/CLAUDE.md`

#### B6: The reader, expressions (part 08, "Files by pull request")

- New: `lib/publish/emissionRewriteIds.ts`, `lib/publish/firstPublishCopy.ts`,
  `lib/commcare/emissionRewrites.ts`; `lib/commcare/reader/expressions/index.ts`, `readExpression.ts`,
  `folds.ts`, `canonical.ts`, `csqlRead.ts`, `searchRows.ts`, `scanReads.ts`, `findings.ts`,
  `surfaceUses.ts`; `lib/agent/authoring/recordRoundTrip.ts`; `lib/commcare/reader/worldEntities.ts`
  (part 11's `worldEntitiesFromReads`); `lib/commcare/reader/search/rows.ts` (part 07's);
  `proof/native/core/ReaderSpellingRuntimeTest.java`, `proof/native/test_csql_reader_parity.py`
- Changed, the parser and the emitter: `lib/commcare/xpath/formParseScope.ts`, `expressionAst.ts`,
  `formPathBinding.ts`, `wire/fromExpression.ts`, `wire/formReads.ts`, `wire/serialize.ts`;
  `lib/commcare/hqJson/caseList.ts`, `suite/case-list/nodesetFilter.ts`, `csql/emitter.ts`,
  `xform/formExpressions.ts`, `expressionContext.ts`, `suite/case-search/xpathQuery.ts`;
  `lib/domain/expression/instantOperand.ts`
- Changed, the reader: `lib/commcare/reader/syntaxCompare.ts`, `defects.ts`, `provisional.ts`
  (`bindExpressions`), `types.ts`, `index.ts`, `xform/index.ts` (`expressionEnvOf`), `search/index.ts`
  (`settleSearches`)
- Changed, agent: `lib/agent/authoring/printQueryExpression.ts`, `queryExpressions.ts`, `bindings.ts`,
  `reference.ts`, `lib/models.ts`
- Manifest and lane: `lib/commcare/surface/entries/expressions-and-data.json`, `case-search.json`;
  `lib/publish/hqFindingCopy.ts`; `proof/native/families.py`, `producers/emit-expression-evidence.ts`,
  `producers/emit-csql-evidence.ts`, `proof/native/test_hq_interpolation.py`,
  `proof/native/core/RowPredicateCurrentRuntimeTest.java`
- Tests named outright: part 08's "Tests" (the nineteen files of `reader/expressions/__tests__/`,
  `rewriteSentences.test.ts`, `dialectReadBack.test.ts`, `instantTextOfMicros.test.ts`), and the B6 cases
  of parts 06 and 07's suites
- Docs: `lib/commcare/CLAUDE.md`, `lib/commcare/xpath/CLAUDE.md`, `lib/commcare/xpath/wire/CLAUDE.md`,
  `lib/agent/authoring/CLAUDE.md`, `lib/domain/expression/CLAUDE.md`, `proof/README.md`

#### B8: Identity and the ledger (part 10, "Files by pull request"; part 01, "Files by pull request", B8)

- New: `lib/case-store/migrations/20261201000000_hq_bring_in_ledger.ts`;
  `lib/commcare/reader/identityMap.ts`; `lib/deployment/adoption.ts`; `lib/db/hqAppClaims.ts`;
  `lib/publish/driftReference.ts`, `stopPublishing.ts`, `hqAppClaims.ts`; `scripts/scan-hq-app-claims.ts`
  (removed in B15)
- Changed, the store: `lib/case-store/migrations/index.ts`, `lib/db/pg.ts`, `privilegeConvergence.ts`,
  `apps.ts`
- Changed, the deployment: `lib/deployment/types.ts`, `errors.ts`, `stateMachine.ts`, `resources.ts`,
  `store.ts`, `service.ts`, `preflight.ts`, `remoteChanges.ts`, `webApps.ts`, `observe.ts`,
  `importApplication.ts`, `hqSourceBaseline.ts`, `downloadTarget.ts`, `workers.ts`, `actions.ts`,
  `index.ts`, `targetFacts.ts`
- Changed, publish, media and the archive: `lib/publish/webApps.ts`, `planFeatures.ts`,
  `exportAdvisories.ts`, `keptValues.ts`, `hqFindings.ts`, `hqFindingCopy.ts`; `lib/media/manifest.ts`;
  `lib/export/boundaryValidation.ts`; `lib/commcare/multimedia/mediaSuiteXml.ts`,
  `multimedia/assetWirePath.ts` (a comment); `lib/commcare/targetOverlay.ts`,
  `lib/commcare/targetFacts.ts`, `lib/commcare/keptProfile.ts`, `lib/commcare/compiler.ts`,
  `lib/commcare/appProfileSettings.ts` (header), `lib/commcare/surface/keptAtHq.ts`, the sixteen entry
  cells of part 01's sections 7.2 and 7.3; `lib/commcare/reader/appShell.ts`
- Changed, surfaces: `app/api/compile/prepareCompileRequest.ts`, `lib/mcp/tools/compileApp.ts`,
  `app/api/commcare/upload/route.ts` (the `viewer` field), `lib/mcp/tools/uploadAppToHq.ts`,
  `lib/mcp/errors.ts`, `lib/apiError.ts`, `lib/mcp/tools/deploymentProjection.ts`,
  `app/(app)/(site)/app-actions.ts`, `components/builder/DeploymentStatus.tsx`, `PublishDialogBody.tsx`,
  `publishOutcome.ts`
- Lane and e2e: `proof/corpus/publish.ts`, `proof/corpus/__tests__/publish.postgres.test.ts`,
  `e2e/lib/publishing-boundary.ts`, `e2e/tests/browser/publishing.spec.ts`
- Tests named outright: `hqBringInLedger.postgres.test.ts`, `identityMap.test.ts`,
  `identityMapParity.test.ts`, `adoption.test.ts`, `hqAppClaims.postgres.test.ts`,
  `adoptedLedger.postgres.test.ts`, `endDeployment.postgres.test.ts`, `hqAppClaimsVocabulary.test.ts`,
  and the additions part 10's "Tests" lists
- Docs: `lib/deployment/CLAUDE.md`, `lib/db/CLAUDE.md`, `lib/media/CLAUDE.md`, `lib/commcare/CLAUDE.md`

#### B9: Project data (part 11, "Files by pull request")

- New: `lib/media/publishReadyMedia.ts`, `stagedMedia.ts`, `stagedMediaFile.ts`; `lib/lookup/managed.ts`,
  `managedRules.ts`; `lib/organization/managed.ts`; `lib/deployment/managedData.ts`,
  `managedDataActions.ts`; `lib/deployment/reading/projectData/index.ts`, `reviewTypes.ts`, `review.ts`,
  `media.ts`, `lookupTables.ts`, `places.ts`, `settlements.ts`, `read.ts`, `mediaStore.ts`,
  `lookupTableStore.ts`, `placeStore.ts`; `lib/publish/managedData.ts`;
  `lib/case-store/migrations/20261202000000_hq_bring_in_project_data.ts`;
  `components/builder/project-data/ManagedTableBanner.tsx`, `ManagedTableDialogs.tsx`;
  `components/builder/app-setup/ManagedPlacesBanner.tsx`; the lane document `targeted-missing-media`;
  `e2e/tests/app/managed-project-data.spec.ts`
- Changed, media and lookup: `lib/media/validate.ts`, `lib/mcp/tools/uploadMediaAsset.ts`;
  `lib/lookup/writerTransaction.ts`, `service.ts`, `authoringBatch.ts`, `schemaGovernance.ts`,
  `definitionSnapshot.ts`, `types.ts`, `errors.ts`, `actions.ts`; `lib/collab/lookupManifestFrame.ts`
- Changed, organization and the store: `lib/organization/writerTransaction.ts`, `service.ts`,
  `commitIntegrity.ts`, `errors.ts`, `types.ts`; `lib/db/pg.ts`, `lib/case-store/migrations/index.ts`
- Changed, the deployment and the export: `lib/deployment/preflight.ts`, `lookupResourcePlan.ts`,
  `service.ts`, `store.ts`, `types.ts`, `workerProvisionPlan.ts`, `workers.ts`;
  `lib/export/boundaryValidation.ts`; `lib/commcare/lookup/xmlText.ts`, `hqCellText.ts`;
  `lib/publish/manualImportGuide.ts`; `lib/commcare/multimedia/hqJsonExportArchive.ts`;
  `lib/mcp/tools/compileApp.ts`; `app/api/compile/json/route.ts`;
  `app/api/projects/[projectId]/lookup/tables/[tableId]/import/route.ts`
- Changed, the reader: `lib/commcare/reader/worldEntities.ts` (`levelsFromHq`), `structure.ts`
- Changed, agent: `lib/agent/tools/getLookupTables.ts`, `organization.ts`, `authoring/reference.ts`,
  `scripts/test-schema.ts` (the `getOrganization` entry), `lib/models.ts`
- Changed, findings and the manifest: `lib/publish/hqFindings.ts`, `hqFindingCopy.ts` (six circumstance
  codes), `lib/commcare/surface/entries/expressions-and-data.json`
- Changed, the builder: `components/builder/project-data/ProjectDataTableListScreen.tsx`,
  `ProjectDataTableScreen.tsx`, `TableActions.tsx`, `projectDataInspector.tsx`,
  `ColumnInspectorBody.tsx`, `LookupOrderingSection.tsx`, `useProjectData.ts`, `projectDataModel.ts`;
  `components/builder/app-setup/OrganizationSection.tsx`, `PlacesSubsection.tsx`, `LevelsSubsection.tsx`,
  `PersonasSubsection.tsx`
- Lane and e2e: `proof/views/test_lookup_upload.py`, `proof/corpus/publish.ts`, `targetPeer.ts`,
  `proof/corpus/__tests__/publish.postgres.test.ts`; `e2e/lib/smokeProfiles.ts`, `smokeSeedFactory.ts`,
  `e2e/seed.ts`
- Tests named outright: part 11's "Tests" (seventeen new files, eight extended)
- Docs: `lib/lookup/CLAUDE.md`, `lib/media/CLAUDE.md`, `lib/organization/CLAUDE.md`,
  `lib/deployment/CLAUDE.md`, `lib/export/CLAUDE.md`
- Only under an outcome: `lib/deployment/service.ts::withoutHeldMedia` with `publishHeldMedia.test.ts`
  (part 10's G2, outcome C); the refusal `managed-table-shares-the-space` in `lookupResourcePlan.ts` (R1,
  outcome B)

#### B7: Acceptance and the first-publish register (part 09, "Files by pull request")

- New: `lib/deployment/reading/acceptance.ts`, `emission.ts`, `fixedPoint.ts`, `identityAgreement.ts`,
  `summaryAgreement.ts`, `signature.ts`, `readBack.ts`, `firstPublishChanges.ts`, `adoptionBoundary.ts`;
  `lib/export/boundaryFindings.ts`; `lib/commcare/hq/sourceIdentity.ts`, `hqQuestionTypes.ts`;
  `lib/commcare/reader/canon.ts`; `lib/commcare/appStrings.ts`; `lib/publish/firstPublishChangeIds.ts`;
  `proof/hq/test_question_type_rows.py`, `proof/hq-reads/reading/question-type-rows.json`;
  `proof/ci/__tests__/firstPublishChanges.test.ts`
- Changed: `lib/commcare/emissionRewrites.ts`, `lib/publish/emissionRewriteIds.ts`,
  `lib/publish/firstPublishCopy.ts`; `lib/export/boundaryValidation.ts`; `biome.json` (both overrides and
  the four messages gain `lib/export/boundaryFindings`, and each message's first sentence is section
  6.5's here); `lib/deployment/types.ts`, `store.ts`, `adoption.ts`, `service.ts`, `resources.ts`,
  `actions.ts`, `index.ts`; `lib/commcare/expander.ts`, `xform/builder.ts`,
  `xform/constraintCollections.ts`, `xform/constraintMessage.ts`, `xform/datetimeCaseValue.ts`,
  `xform/generatedNodes.ts`, `casePlacementPlan.ts`, `compiler.ts`, `hq/publishedCaseBlocks.ts` (its
  header)
- Lane: `proof/first-publish-changes.json` (completed), `proof/checks/changes.py` (`CANDIDATE_IDS`
  deleted), `proof/corpus/publish.ts` (the empty `firstPublish`)
- Removed: `lib/commcare/__tests__/rewriteSentences.test.ts`
- Tests named outright: part 09's "Tests" (the seventeen files of `lib/deployment/reading/__tests__/`,
  `firstPublishBaseline.postgres.test.ts`, the four of `lib/commcare/hq/__tests__/`, `canon.test.ts`,
  `appStrings.test.ts`, `emissionRewrites.sites.test.ts`, `emissionRewrites.test.ts`,
  `withheldCount.test.ts`, `generatedNodePaths.test.ts`, `firstPublishCopy.test.ts`)
- Docs: `lib/commcare/CLAUDE.md`, `lib/deployment/CLAUDE.md`, `lib/export/CLAUDE.md`

#### B10: The reading and the birth (part 12, "Files by pull request")

- New: `lib/case-store/migrations/20261203000000_hq_app_readings.ts`; `lib/deployment/reading/types.ts`,
  `budget.ts`, `store.ts`, `beat.ts`, `slot.ts`, `service.ts`, `gather.ts`, `check.ts`,
  `checkWorker.ts`, `checkInWorker.ts`, `mediaIds.ts`, `digest.ts`, `create.ts`, `birth.ts`,
  `census.ts`, `learned.ts`, `index.ts`;
  `lib/publish/hqReadingCopy.ts`; `app/api/commcare/readings/route.ts`, `[id]/route.ts`,
  `[id]/advance/route.ts`, `[id]/check-again/route.ts`, `[id]/create/route.ts`;
  `scripts/inspect-hq-readings.ts`
- Changed: `lib/case-store/migrations/index.ts`; `lib/commcare/surface/revision.ts` (`currentStandingOf`,
  `isDeclaredSurfaceKey`); `lib/db/pg.ts`, `privilegeConvergence.ts`, `appGenesis.ts` (the seam
  `afterAppInsert`), `apps.ts`, `placementAuthority.ts`, `placementRecords.ts` (comments);
  `lib/apiError.ts`; `scripts/build-xpath-worker.mjs`, `.gitignore` (the bundle
  `public/reading-check/worker.mjs`); `cloudbuild.yaml` and
  `scripts/infra/__tests__/cloudBuild.test.ts` (the `deploy` step's `--memory=2Gi`, the value the
  service holds; part 12, section 3.6); `lib/deployment/index.ts`; `components/chat/chatLifecycle.ts`,
  `ChatContainer.tsx`; `app/(app)/build/actions.ts` (a comment); `lib/publish/hqFindings.ts`,
  `hqFindingCopy.ts`, `lib/publish/__tests__/hqFindingCopy.test.ts`
- Tests named outright: part 12's "Tests" (the eighteen files of `lib/deployment/reading/__tests__/`
  with `adoptionFixture.ts`, the two worker fixtures, `hqAppReadings.postgres.test.ts`,
  `routes.test.ts`, `hqReadingCopy.test.ts`, `chatLifecycle.adoption.test.ts`); and, outside every
  default project, run M1's `checkMemory.scale.test.ts` with its child
  `fixtures/readStepMemoryChild.ts`
- Docs: `lib/db/CLAUDE.md`, `lib/deployment/CLAUDE.md`, `components/builder/CLAUDE.md`,
  `lib/collab/CLAUDE.md`
- Not edited, and held so: `lib/hostnames.ts`, `proxy.ts`, `config/runtime-capabilities.json`,
  `lib/db/appTests.ts`, `lib/models.ts`, `scripts/test-schema.ts`, `lib/mcp/**`, `lib/doc/**`

#### B11: The experience (part 13, "Files by pull request", B11)

- New: `components/bring-in/bringInModel.ts`, `bringInClient.ts`, `useBringIn.ts`, `BringInFlow.tsx`,
  `BringInPicker.tsx`, `BringInReading.tsx`, `BringInStop.tsx`, `BringInAccount.tsx`,
  `BringInReview.tsx`, `ReviewRunsOn.tsx`, `ReviewTableChoice.tsx`, `FirstPublishLines.tsx`;
  `components/builder/HqNotConnected.tsx`, `StopPublishingDialog.tsx`;
  `components/shadcn/radio-group.tsx`, `design/components/core/RadioGroup.prompt.md`;
  `app/(app)/(site)/readings-in-progress.tsx`, `readingRowModel.ts`; `app/api/commcare/hq-apps/route.ts`,
  `app/api/commcare/connection/route.ts`; `lib/routing/bringInLocation.ts`; `lib/publish/bringInCopy.ts`;
  `lib/deployment/reading/picker.ts`, `pickerTypes.ts`; `lib/deployment/hqPlaceUrl.ts`;
  `e2e/lib/bring-in-client.tsx`, `bringInSeed.ts`, `e2e/tests/browser/bring-in.spec.ts`,
  `e2e/tests/app/bring-in.spec.ts`
- Changed: `app/(app)/(site)/app-list.tsx`, `page.tsx`, `app-list-body.tsx`, `RefreshStaleAppList.tsx`;
  `app/(app)/build/[id]/[[...path]]/page.tsx`; `components/chat/StartFromScratch.tsx`, `ChatSidebar.tsx`,
  `ChatContainer.tsx`; `components/builder/BuilderLayout.tsx`, `CommCareConnectionContext.tsx`,
  `PublishPanel.tsx`, `DeploymentStatus.tsx`, `PublishDialogBody.tsx`, `publishOutcome.ts`,
  `app-setup/publishingSectionModel.ts`, `app-setup/PublishingSection.tsx`,
  `detail/appSettings/AppPlatformsSection.tsx`; `lib/domain/platforms.ts` (`PLATFORM_DECLARATION_LINES`);
  `lib/routing/useClientPath.ts`; `lib/ui/appListFreshness.ts`; `lib/deployment/reading/index.ts`,
  `lib/deployment/index.ts`; `e2e/lib/smokeProfiles.ts`, `smokeSeedFactory.ts`,
  `e2e/tests/browser/publishing.spec.ts`
- Tests named outright: part 13's "Tests", B11 (ten new files, three extended)
- Docs: `design/readme.md`, `components/CLAUDE.md`, `components/builder/CLAUDE.md`,
  `lib/routing/CLAUDE.md`, `e2e/CLAUDE.md`

#### B12: MCP, the guide and the billed check (part 13, "Files by pull request", B12)

- New: `lib/mcp/tools/listHqApps.ts`, `readHqApp.ts`, `bringInHqApp.ts`, `stopPublishing.ts`,
  `managedData.ts`, `readingProjection.ts`
- Changed: `lib/mcp/server.ts`, `errors.ts`, `app/api/mcp/dispatch.ts` (a comment);
  `lib/mcp/tools/deploymentProjection.ts`, `deploymentTools.ts`, `checkProjectSpaceCompatibility.ts`,
  `uploadAppToHq.ts`, `getHqConnection.ts`; `lib/publish/bringInCopy.ts`;
  `lib/agent/authoring/reference.ts`; `lib/models.ts`
- Tests named outright: `lib/mcp/__tests__/readingProjection.test.ts`, `bringInToolScopes.test.ts`,
  `bringInTools.postgres.test.ts`, and the changed `servedSchemas.test.ts`, `errors.test.ts`,
  `compatibility.postgres.test.ts`, `deploymentTools.postgres.test.ts`
- Docs: `lib/deployment/CLAUDE.md`, `lib/agent/authoring/CLAUDE.md`
- Only under E1's outcome B: `lib/agent/tools/getLookupTables.ts` or `lib/agent/tools/organization.ts`,
  or the file of a further tool the hash run named (section 3, rule 7)
- In its own repository and its own pull request: `../nova-plugin` (section 9.2)

#### B13: Proof at full (part 14, "Files by pull request", B13)

- New, the reader bundle: `proof/reader/laneReading.ts`, `retainedPeer.ts`, `laneIds.ts`, `cli.ts`,
  `build.mjs` and its three tests
- New, the judges: `proof/checks/proof6.py`, `parity.py`, `source.py`, `readerbundle.py`,
  `fixtures/source-families.json`, `test_proof6_fixed_point.py`, `test_proof6_controls.py`,
  `test_parity.py`, `test_parity_controls.py`, `test_source.py`, `test_first_publish_changes.py`,
  `test_first_publish_changes_controls.py`; `proof/rules/field_list_appearance_case.py` with its test
- New, the bases and variants: `proof/matrix/bases/*.py` (one module a base), `variants/*.py` (one a
  manifest area), `media.py`, `patch.py`, `schema_samples.json`, `exemptions.json`,
  `fixtures/patch-vectors.json`, `test_classified.py`, `test_media.py`, `test_patch.py`;
  `proof/matrix/hand/<base>/expectations.json` and `restore.xml` for each base and `edit.ts` for two;
  `proof/hq-apps/<base>/` for twenty-one bases and every variant, and `application.json`,
  `current-version.json`, `expected.json` for `hq-plain`
- New, the targeted document and the suites: `proof/targeted/documents/saveToCaseShapes.ts`;
  `__tests__/helpers/retainedHqApps.ts` with its test; `lib/commcare/reader/__tests__/hqApps.test.ts`,
  `hqAppVariants.test.ts`, `schemaKeyVariants.test.ts`, `fixedPoint.retained.test.ts`,
  `twoRefusals.test.ts`; `lib/commcare/surface/__tests__/entryCoverage.test.ts`;
  `proof/corpus/__tests__/hqAuthored.test.ts`; `proof/ci/__tests__/readerBundle.test.ts`; the G1 case of
  `lib/commcare/reader/caseManagement/__tests__/saveToCase.retained.test.ts`
- Changed: `proof/native/produce.py`, `proof/ci/products.mjs`; `proof/observe/unit.py`, `sessions.py`,
  `casedata.py`, `publish.py`; `proof/formplayer/hq.py`; `proof/hq/operations.py`,
  `proof/hq/test_retained_reads.py`; `proof/matrix/registry.py`, `author.py`, `retain.py`, `seed.py`,
  `adopt.py`, `test_expectations.py`, `test_retained.py`, `conftest.py`; `proof/checks/differences.py`,
  `registers.py`, `observations.py`, `eligibility.py`, `changes.py`, `manifest_usage.py`,
  `manifest_value_classes.py` and the tests beside them, `sharding.py`; `proof/store/keys.py`,
  `queue.py`, `pack.py` and their tests; `proof/lane/blocks.py` with its test;
  `proof/corpus/documents.ts`, `hqAuthored.ts`, `emit.ts`, `entryWriter.ts`;
  `proof/views/test_exports.py`; `.github/workflows/upstream-pins.yml`, `proof-lane.yml`;
  `proof/upstream/pins.mjs` with its test; `proof/timings.json`
- Moved or removed: `proof/corpus/hq/test_privileges.py` to `proof/hq/test_privilege_rules.py`; the rest
  of `proof/corpus/hq/` and `proof/views/reading_reads.py` removed
- Docs: `proof/README.md`, `proof/CLAUDE.md`, the root `CLAUDE.md` (the `proof/` bullet),
  `lib/commcare/CLAUDE.md` (one sentence on coverage)

#### B14 and B15

Section "Files by pull request", at the end of this part.

## 2. Ordering constraints

### 2.1 What precedes what, and why

| Constraint | Reason |
|---|---|
| This plan's own pull request beneath both stacks | It replaces the outline's row in the plans `README.md`, removes the outline, rewrites `7-rest-of-model.md` with the ten group ids A2 writes into every HELD-NEW entry's `owner`, and writes `harness-findings.md`'s "Found while planning step 6" (section 8), before any of step 6's code lands |
| A1 first, and settled on its own branch before stack A is cut | It changes the observation's code, so every later lane reads it, and its probe (P1) assigns each emission gap it finds to a named pull request of stack A before that pull request is written. A fix to A1 after the cut restacks ten whole lanes (part 14, section 12.1) |
| A2 beneath A3, A4 and A9 | A3's flips remove the `subject` and `owner` A2 adds, and its entries parse under A2's TARGET-OWNED schema arm (part 01, sections 2.5, 3.8). A4's and A9's entries are written in the new schema, and A9 edits the `SUBJECTS` and `FINDING_COPY` A2 creates (part 02, section 14; part 04, "What this part needs of other parts") |
| A3 and A5 beneath A9 | A9 removes the `widen` direction from `slotChangeSchema`, which parses only once A3 has taken the sixteen widens of the settings rows and A5 the one of `case-list-form-post-form-workflow-default-case-list` (part 04, sections 2.4, 11.4) |
| A4 beneath A5 | A5 refuses a host that shows its forms above, lands its return on `screenOfFrame`, and builds its frames through `menuIdOf`, each A4's (part 02, sections 4, 6.3, 11.3, 11.5) |
| A6 beneath A7 beneath A8 | A8's `markdown` arguments edit the `addItext` calls A7's atoms pass through, and the three share `lib/agent/toolSchemaGenerator.ts` and the guide's forms paragraph in that order (part 03, "What this part needs of other parts", part 15 (b)) |
| A8 beneath A9 | A9 splits `questions/help-text-markdown-form` after A8 re-words it, and keeps A8's wording on the HELD half (part 03, section 10; part 04, section 11.1) |
| A4 to A9 beneath A10 | A10 holds the stack's one billed ask, over every tool any of them moved, and reads the guide once every sentence has landed |
| A10 beneath A11 | A11's public sentences describe what the stack leaves, the outcomes of part 03's G4 and G5 among them, and it records H4's result |
| Stack A merged, deployed and through its first green scheduled night before stack B opens for merge | The reader is written against every concept of stack A (part 06, section 1), so stack B is cut from the `main` that holds it; and stack B's pull requests read `main`'s evidence store, which holds no record made under stack A's keys until that night (part 14, section 12.2). This is evidence and no window: nothing is scheduled around it |
| B1 beneath B2 | The reader's inputs are B1's types (`HqAppSource`, `HqAlignedModule`, `HqQuestionSummary`), and every HQ read in the stack goes through B1's one call path: one reader, `readHqJson`, and one failure classification (part 05, decisions 1 and 4) |
| B2 beneath B3, B4 and B5, and all four beneath B6 | B2 is the frame every stage claims through. B3 to B5 register expressions that B6 binds between their two passes, and code that names a B6 export lands in B6 (`bindExpressions`, `expressionEnvOf`, `settleSearches`, `worldEntitiesFromReads`; part 08's opening and its "Files by pull request") |
| B6 beneath B8, B9 and B7 | B7 appends to B6's `EMISSION_REWRITES` and moves its sentences; B9 adds `levelsFromHq` to the file B6 creates; B8's `identityMapParity.test.ts` reads the whole reader |
| B8 beneath B9 | B9's migration is registered after B8's, and B9 calls B8's `assignMediaPaths`, `mintingResolver` and `app_deployment_media_paths` (part 11, section 6.1 and "What this part needs of other parts") |
| B8 and B9 beneath B7 | Acceptance calls `adoption.ts` and `identityMap.ts` (B8) and project data's three pure exports (B9), and B7 adds the writer and the readers of the column B8's migration lands. Nothing of B8 or B9 imports a symbol of B7 (part 09, Departure 14) |
| B7 beneath B10 | The read step calls `acceptReading`, and the birth writes the chosen declaration's first-publish list through B7's writer (part 12, sections 3.3, 6.2) |
| B10 beneath B11 beneath B12 | B11 mounts the flow over B10's six routes and draws only the states B10 defines (part 13's opening: it adds no reading state); B12 registers its tools over B10's and B9's services and adds its sentences to B11's copy file. No reading reaches a person before B11, and the stack merges whole, so the entry point needs no flag |
| B13 above B10 and beneath B14 | It calls `runReadingCheck`, B7's acceptance and comparison, B8's identity functions and B9's project data functions, and nothing of B11 or B12 (part 14, "What this part needs of other parts"). It sits above B12 so that B1 to B12 run no whole lane (part 14, section 12.1) |
| B14 beneath B15 | B14's sentences describe what the stack leaves; B15 removes the plan those sentences were planned in |
| The four ledgered migrations sort in pull request order | `20261113000000` (A9), `20261201000000` (B8), `20261202000000` (B9), `20261203000000` (B10). The stamps are final with one rule, which the part of each migration states too (part 04, section 9.3; part 10, section 11; part 11, section 6.1; part 12, "What this part needs of other parts"): where `main` holds a later-stamped migration when the pull request is rebased, the stamp moves to the next free hour after `main`'s newest, and every later stamp of the stack keeps its order |
| Each manifest entry flips in the pull request whose code first makes its new wording true | The lane's HELD-NEW check fails any head whose corpus emits an item only HELD-NEW entries name, and a reading claim cannot be checked before its reader exists (section 1.3 here; part 01, section 3) |

### 2.2 No pull request is split

A pull request is split only where each half is green alone, each half is one complete behavior, and
no migration, manifest count, version literal or lane key is cut across the halves. Five pull
requests are large enough to ask the question, and none meets the test:

| Pull request | Why it stays whole | What its `/code-review medium` reads first |
|---|---|---|
| A9 | `widen` leaves the schema only when all forty-five rows are answered, and one hash run, one literal and one migration cover the nine grammars; R2's fallbacks move rows between its halves | `lib/commcare/xpath/grammar.lezer.grammar` and `hashtagGuard.ts`, `lib/domain/hashtagSegments.ts`, the migration, `lib/commcare/xform/itextIds.ts` |
| B8 | One migration carries the claim, the ending, the media paths, the baseline's map and part 09's column, and each of its writers is the only caller of a column that migration adds | the migration, `lib/db/hqAppClaims.ts`, `lib/deployment/adoption.ts`, `service.ts`'s four changes to `publishAppToHq`, `lib/db/privilegeConvergence.ts` |
| B9 | Media, tables and places meet in one surface (`lib/deployment/reading/projectData/`), one review type file, one settlement function and one migration; a half without the others cannot answer `readReadingProjectData` | `lib/lookup/writerTransaction.ts` and `managed.ts`, `lib/deployment/managedData.ts`, `lookupResourcePlan.ts`, the migration, `lib/media/stagedMedia.ts` |
| B11 | The flow's screens are one reducer's states (`components/bring-in/bringInModel.ts`), and the Publishing card's additions draw the same first-publish renderer the review draws | `bringInModel.ts`, `lib/deployment/reading/picker.ts`, the two routes, `components/builder/publishOutcome.ts` |
| B13 | Its records move every part key once; a second pull request that added the bases after the judges would move them again and run every lane above it twice (part 14, section 12.1) | `proof/checks/proof6.py`, `changes.py`, `parity.py`, `proof/reader/laneReading.ts`, `proof/store/keys.py` |

So the ids of section 1 are the plan's only ids, and no part needs a corrected reference.

## 3. House rules for the stacks

1. **One chain a stack, on the latest `main`.** This plan's pull request merges first. Stack A is one
   `gh stack` chain cut from the latest `origin/main` and rebased on it before its first pull request
   opens; stack B is cut the same way from the `main` that holds stack A. Every pull request is
   undrafted. A pull request's title is one sentence of what it does, in the imperative, with no
   step, stack or pull request number, as `main`'s commits and six of step 5's sixteen are (#841,
   #844). Section 1's "Title" column is a pull request's name in this plan; the titles themselves
   are the table after rule 13.
2. **`/code-review medium` runs on every pull request**, and its findings are fixed there before the
   merge. Where the review's agents sit idle for about a minute with no notification, their findings
   are collected by hand. A real defect a review finds is fixed in scope, or filed as a GitHub issue
   with an owner and named by number in the pull request; that `main` already allows it is no reason
   to pass it. Section 2.2 names the files the five largest reviews read first.
3. **Each stack merges together** with `gh stack merge <top> --squash`: one push, one deploy a stack.
   Never pull request by pull request, and never through the merge API. A repair is made before the
   merge, never between two deploys.
4. **Fix-ups go to the pull request they belong in, and a session's pushes are batched into one.** A
   push to the k-th pull request of stack A starts 12 minus k whole lanes, eleven for A1; a push at
   or below B13 starts three. One whole lane is about 1.45 runner-hours of work and thirteen shards'
   fixed cost (part 14, section 12.1). A change to a lane file is settled at the lowest pull request
   that needs it before the stack above is rebased, and no restack is pushed while a scheduled lane
   with the readers runs.
5. **A1 is settled on its own branch before stack A is cut**: its lane, its tests and a probe run
   whose gate passes (P1). **B1's seven reads are made on its branch before it opens** (part 05's G1
   to G7), because four of their outcomes move a branch of its code.
6. **Proven green before a push, without loading the person's machine.** They work on the laptop
   agents run on. Before a push, at each changed pull request's head and once each: typecheck, lint,
   the Vitest the diff reaches (`npm run test:changed`) and the Playwright smoke. CI is never used to
   find the next failure. No run is repeated to chase a flake, no suite is looped, and no lane slice,
   native family, reader, scale test or fresh lane runs there: those go to GitHub's runners, asked
   first. The no-Docker corpus emission with `--jobs 2` is the one lane command that belongs on the
   machine.
7. **No billed call without a yes, each time.** Stack A's check is H1, asked once at A10's head;
   stack B's is part 13's E1, asked once as B12's first act, with its own question. On a yes the
   implementer runs `npm run test:schema -- <name>` once for each name, never the bare command. A
   refused schema is corrected and that one entry is asked about again. There is no standing
   approval, and a no leaves the stack unmerged. E1's list is the hash run's, by 13.4's rule: the
   implementer runs `scripts/inspect-tool-schema-hashes.ts` at the `main` stack B was cut from and
   at B12's head, and the list is every Solutions Architect tool whose hash differs. `getLookupTables`
   and `getOrganization` are expected, both moved by B9. A further name joins the list, and part
   13's question then names the count and the tools the run gave, with the further name called out
   as one the plan did not expect; an expected name whose hash did not move leaves both.
8. **Runs by hand are asked first, each time, with their cost.** A `mechanics` dispatch of eleven or
   twelve bases with every reader is 8 to 31 worker-hours and holds up to fourteen of the account's
   twenty runners for one to three hours (part 14, section 12.4). The commands are `gh workflow run
   proof-audit.yml --ref <branch> -f nightly=false -f mechanics=<ids>`, `gh workflow run
   proof-slice.yml`, `gh workflow run reader-scale.yml` and `gh workflow run ci.yml --ref <branch> -f
   proof_fresh=true`. One dispatch runs at a time, never while a scheduled lane with the readers is
   running. A run's verdict is its gate's summary: what it reported is fixed, proven green where CI
   could fail it, and then pushed.
9. **A production read is asked first and run by the person**, read-only, as their gcloud identity,
   and its output is never committed (section 5.3).
10. **After each merge, the deploy is watched on the merge commit with `gh`.** The commit's
    check-runs are listed first (`gh api repos/voidcraft-labs/commcare-nova/commits/<sha>/check-runs
    --jq '.check_runs[] | {name, app: .app.name, status, conclusion}'`) and the watch is built from
    the name and app observed there; an empty list is an error to look into, never a reason to keep
    waiting. Pull request CI being green is not a deploy: the deploy applies the stack's migrations
    through the migration Job and runs the runtime probe over every saved app, and a refusal of
    either blocks it with the previous revision still serving.
11. **The first scheduled night after each merge is the whole lane with every reader.** Each stack
    moves every part key, so that night observes every group: about 605 worker-hours after stack A
    and about 665 after stack B, as counted before a measure (part 14, section 12.2). A night that
    fails opens an issue naming each failing group with the command that reruns it alone; the
    implementer fixes from that list and reruns only the documents on it. After stack B's first
    weekly whole run, the person who merged it opens one ordinary pull request, with its own
    `/code-review medium`, that commits `node proof/run.mjs --timings` over that run's outputs.
12. **Three issues are filed before their pull requests open**, each by its implementer, assigned to
    themselves, with its number named in the pull request's description: before A2, "A language
    removed in Nova stays in CommCare HQ's build profiles" (part 01, section 3.7; step 7's group
    `settings-nova-comes-to-own` fixes it, as the owner of
    `application-and-settings/build-profiles-non-empty`); before A3, "Preview keeps a filtered tile
    list's groups in their unfiltered order, where Web Apps orders them by each group's first match"
    (part 01, section 6.4); before A7, "A Connect block's name or description holding instance('…')
    reaches CommCare HQ's instance scan" (part 03, "What this part needs of other parts", part 15
    (d)), retitled as part 03's G2 outcome C writes where that outcome lands. Each is a defect of
    today's Nova that planning found and step 6 does not fix, and each is the one
    `harness-findings.md` names under "Defects of Nova's own, found by reading".
13. **A `../nova-plugin` change rides its own pull request**, opened beside the stack's agent pull
    request (A10, B12) and merged only after that stack's deploy is live, which rule 10 confirms
    (section 9).

**The titles** (rule 1), each a sentence that stays true once this plan has left the repository:

| # | Title of the pull request |
|---|---|
| A1 | Add apps made in CommCare HQ to the proof lane as a sixth corpus source, with a probe base |
| A2 | Derive every manifest entry's standing, and name a subject and an owner where Nova holds less |
| A3 | Keep what stays CommCare HQ's at its value in the archive, in Preview and on the Publishing card |
| A4 | Let a menu show its forms in the menu above |
| A5 | Offer a registration form from a case list at any time |
| A6 | Add the Phone Number question as a Text question with a number keypad |
| A7 | Show a calculated value in a question's text |
| A8 | Hold a search with no title, where blanks sort, and text shown as typed |
| A9 | Widen the identifier grammars to the names CommCare HQ's editors accept |
| A10 | Make the schema check's prompts use each new tool input |
| A11 | Document menus, text and names in the architecture reference and the public docs |
| B1 | Read an app, its media, its lookup tables and its places from CommCare HQ |
| B2 | Add the reader's frame, which accounts for an HQ app against the surface manifest |
| B3 | Read an HQ app's forms into questions, text and pending logic |
| B4 | Read an HQ app's case management, menus and links |
| B5 | Read an HQ app's case lists and search |
| B6 | Read an HQ app's expressions by printing a candidate and comparing syntax trees |
| B8 | Record a brought-in app's identity, its hold on its HQ app and the end of a deployment |
| B9 | Bring in media, lookup tables and places as copies CommCare HQ manages |
| B7 | Accept a reading by five checks and declare what its first publish changes |
| B10 | Keep a reading of an HQ app as a durable record and create the app from it |
| B11 | Add the flow that brings an app in from CommCare HQ |
| B12 | Serve bringing an app in over MCP and teach the guide about a brought-in app |
| B13 | Prove the reader over apps made in CommCare HQ, with proof 6 and parity |
| B14 | Document bringing an app in across the contracts and the public docs |
| B15 | Remove the plan for bringing an app in, and its one-off scan |

Removing the plan at the top of stack B, and not in a follow-up, keeps steps 2 to 5's choice: a
later removal would be a third deploy that exists only because of the split.

## 4. The model-addition checklist, applied to stack A

Each addition is complete when its pull request lands. The places are step 5's sixteen, grouped
here into the ten columns below; each cell names what the addition does at that place and the part
and section that settles it. "None" carries its reason. Stack B adds no authored concept: it reads
into the concepts that exist.

The columns: **Builder** (the cards and every offering site); **SA and MCP** (the shared tool inputs,
the reads, the guide); **Validator** (the codes with their rows in `errors.ts`,
`gate.ts::VALIDITY_CLASS_BY_CODE` and `lib/doc/userFacingErrors.ts`); **Emitter**; **Preview, by
platform**; **Public docs** (all in A11, section 7); **Manifest**; **Platform row and cells**
(`lib/domain/platforms.ts`, `platformFeatureEntries.ts`, `lib/preview/__tests__/platformCells.ts`);
**Literal** (`MODEL_CONTEXT_VERSION`); **Plugin** (the claim swept in `../nova-plugin`, section 9).

| Concept (pull request) | Builder | SA and MCP | Validator | Emitter | Preview, by platform | Public docs | Manifest | Platform row and cells | Literal | Plugin |
|---|---|---|---|---|---|---|---|---|---|---|
| Display-only forms (A4) | the switch **Show its forms in the menu above** in module settings, the tree row's second line, the name and appearance notes, display-condition copy, the After submit and link pickers, entry point and Search controls disabled with the gate's sentence (part 02, section 9, "Copy") | `updateModule.forms_in_menu_above`; `getModule`'s `formsInMenuAbove` and `listsOn`; the summary line; one guide paragraph (part 02, section 12) | `FORMS_IN_MENU_ABOVE_NOT_A_DESTINATION`, `FORMS_IN_MENU_ABOVE_WITH_SEARCH`, `FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE`, the reason `first-menu-shared-case` of `ENTRY_POINT_INVALID`, three reasons of `POST_SUBMIT_NOT_OFFERED`, three explanations of `FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE` (part 02, section 5; checklist row 2) | `put_in_root`, the add-on `menu_mode`, the `<menu>` id, root, text and conjoined condition, every stack frame through `menuIdOf`, on both emitters (part 02, section 6) | both platforms list and land alike, by `previewScreenEntries` and `screenOfFrame`; no rule field (part 02, sections 2, 8; run G2) | `nested-menus.mdx`, `display-conditions.mdx`, `form-links.mdx`, `deep-links.mdx`, `mcp/tools.mdx` | `menus-and-case-lists/put-in-root-display-only-forms` to HELD; its REFUSED sibling gains its lane reader; `application-and-settings/menu-mode` re-worded (part 02, section 14) | none: RUNS on both (part 02, section 13); a `different` reading and a cell only under G2's outcome C | `.a4` | "every menu has its own screen": no skill says it |
| Registration from the case list (A5) | **Register from this list** on the Results canvas, the form's "Also offered on" row, the removal refusal with **Stop offering it**, the platform note (part 02, section 11.7, "Copy") | `updateModule.register_from_case_list`; `setMenuMedia`'s target `case-list-registration`; `getModule`, `getForm`; the summary line; one guide paragraph; the form tools' closing sentence (part 02, section 12) | `CASE_LIST_REGISTRATION_FORM_NOT_FOUND`, `_HOST_NOT_CASE_FIRST`, `_HOST_SHOWS_FORMS_ABOVE` (reasons `host` and `parent-shares-first-menu-case`), `_ADVANCED_MENU`; `several-registrations` on `_NOT_REGISTRATION` for both arms; the one app rule (part 02, section 11.3) | `case_list_form` with `post_form_workflow` and its media, no synthetic module, the Register action on both short details, one or two return frames (part 02, section 11.5) | the Register action and its return on both; Web Apps draws the button's text only, by the rule `caseListActionMedia` (part 02, sections 11.5, 13) | `case-workspace.mdx`, `where-workers-use-your-app.mdx`, `mcp/tools.mdx` | two entries to HELD, two re-cut, six HELD-NEW, one REFUSED, one INERT (part 02, section 14) | `case-list-registration-media` (ignored in Web Apps, runs on Android); the cell `menus-and-case-lists/case-list-form-media-image-media-audio@web-apps` with its model check (part 02, section 13) | `.a5` | "registration from a case list needs a search": no skill says it |
| The Phone Number keypad (A6) | the picker entry **Phone number** and the **Number keypad** switch on every Text question (part 03, section 3.5) | `keypad` on `addFields` and `editField`; `getField` prints it; `FIELD_DOCS.keypad`, the kind's `saDocs`, the generated platform sentence (part 03, section 9.1) | none: no code. An author's own validation works as on any Text question (part 03, section 3.3) | `<input appearance="numeric">` with bind `xsd:string`, through the one `appearance` writer (part 03, sections 2.3, 3.7) | the rule `numberKeypad`: `"pattern"` in Web Apps (an answer must match the pattern), `"keys"` on Android (the keypad's characters); one browser cell and scenario (part 03, section 3.6; run G5) | `where-workers-use-your-app.mdx`, `mcp/tools.mdx` | `questions/phone-number-xsd-string-appearance-numeric` to HELD (part 03, section 10) | `number-keypad`, not refusable, `different` in Web Apps and `runs` on Android, bound to the entry; one cell (part 03, section 3.4) | `.a6` | none: no skill names a question setting |
| Calculated values in text (A7) | the reference picker's row **Calculated value**, the popover, the chip, the translation editor's protected part (part 03, section 4.7) | `{{= formula}}` in every wording position (`valueSchemas.text`, `valueSchemas.localized`), read and printed in the text's prose slot; one guide sentence (part 03, section 9.2) | none: the slot's own checker findings, kind `field-prose`; one code under G1's outcome B and one under G3's outcome C (part 03, section 4.2) | `<output value vellum:value>` per atom; `counted` in a validation message's guard; label text CommCare HQ reads as an instance split by a literal output (part 03, sections 4.4, 5) | both platforms print Core's text; Preview evaluates the same expression (part 03, section 4.5; run G3) | `building-with-nova.mdx`, `mcp/tools.mdx` | `questions/output-value-any-other-expression` to HELD (part 03, section 10) | none: both platforms alike (part 03, checklist row 3) | `.a7` | "`{{name}}` inserts an answer": no skill states the wording syntax |
| Plain help, and a form's text formatting off (A8) | the help text's **Format text** toggle; **Format text in this form** with its confirmation; the note under a text's own toggle (part 03, sections 8.1, 8.3, "Copy") | `plain_help` on `addFields` and `editField`; `plain_text` on `createForm` and `updateForm`; the guide's forms paragraph (part 03, section 9.3) | none: schema refusals only | no formatted copy for a help text holding `plainHelp`, none in a form holding `plainText`, which carries `vellum:ignore="markdown"`; none ever for a hint or a validation message (part 03, sections 8.1 to 8.3) | the rule `plainHelp`: as typed on Android, still formatted in Web Apps; one cell gained, two removed (part 03, section 8; run G4) | `where-workers-use-your-app.mdx`, `building-with-nova.mdx`, `mcp/tools.mdx` | `questions/vellum-ignore-containing-markdown-on-h-html-vellum-s-disable` to HELD; `questions/help-text-with-no-markdown-form` new HELD; `questions/validation-message-markdown-form` to INERT; `questions/hint-markdown-form` new INERT; four re-worded (part 03, section 10) | the `plain-text` row's Web Apps note rewritten; one binding gained, one ambient line removed (part 03, section 8.3) | `.a8` | "always Markdown": no skill says it |
| A search with no title (A8) | the switch **Show a title** in the search inspector (part 03, section 6) | `searchScreenTitle` takes `{ "kind": "none" }` on `setCaseSearchDisplay` (part 03, section 9.3) | none | `title_label` blank for every language; the suite's `<title>` over a blank locale (part 03, section 6) | Web Apps draws no heading; Android shows the search action's label, as for every search (part 03, section 6) | none: no page describes a search's title, and the tool's own description carries the arm | `case-search/title-label-or-blank-hq-s-default` to HELD; `case-search/title-label-lang-non-empty` re-worded (part 03, section 10) | none: with no title neither platform draws an authored one, so `search-screen-text` has no use (part 03, section 6) | `.a8` | none |
| A sort rule's blanks (A8) | **Blank values**, **First** or **Last**, on each rule of the sort stack (part 03, section 7) | `blanks` on the column tools' `sort`, stored through `columnSort` (part 03, section 9.3) | none beyond the schema's refusal of a `blanks` equal to the direction's own, which no writer can meet (part 03, section 7) | `blanks: rule.blanks` on HQ's JSON and the suite's `<sort blanks>`, already read from the plan (part 03, section 7) | both platforms place blanks by the rule; Preview's and the case store's order already read `rule.blanks` (part 03, section 7) | `mcp/tools.mdx` | `menus-and-case-lists/blanks-first-last` to HELD (part 03, section 10) | none | `.a8` | none |
| Hyphens in question ids (A9) | the id field's verdicts, shared with the tools (`lib/doc/identifierVerdicts.ts`; part 04, section 3.1) | the same verdicts on `addFields` and `editField`; `FIELD_DOCS.id` unchanged (part 04, section 13) | the grammar is HQ's form builder's; three derivations made injective, so no new code (part 04, sections 3.1 to 3.4) | `FormPath` admits the hyphen; an itext key doubles an id's own hyphen (part 04, sections 3.2, 3.3) | both alike; Preview's query wrapper is `<id>.query`, which moves `RUNTIME_VERSION` to 19 (part 04, section 3.4) | none: no page states the id grammar | the question id rows of part 04's sections 2.1 and 11.1 | none | `.a9` | none: the plugin's one hyphen sentence is a project space's slug |
| The case type grammar, and no reserved type names (A9) | the case type picker's creation message (`caseTypePickerModel.ts`; part 04, section 4.4) | case type patterns on the case operation tools and the `cases` source (part 04, section 13) | `CASE_TYPE_PATTERN`; `RESERVED_CASE_TYPE_NAMES` and `reservedNamespaces.ts` leave; `ownCaseOperationId` and `hqLoadReference` kept sound (part 04, sections 4.1 to 4.3) | every place the type is written (part 04, section 4.2) | both alike: Preview reads types as strings (part 04, section 4.2) | none | `menus-and-case-lists/modulebase-case-type` and N-entries of part 04, section 11 | none | `.a9` | none |
| `#record/<type>/<property>` in reference text (A9) | the reference chips and autocomplete print through `caseReferenceText` (part 04, section 5.2) | the guide's sentence in `expressions`; the record dialect's printer (part 04, sections 5.2, 13) | the Lezer grammar's hashtag segment; run R1 (part 04, section 5.1) | reference text is never on the wire: `hqLoadReference` takes the typed read (part 04, sections 4.3, 5.2) | none: Preview evaluates the typed tree | none: the guide teaches it, and no page shows reference text for a type named for a fixed word | none: a spelling of an identity Nova already holds | none | `.a9` | none |
| A case write's property grammar; `category` and `state` (A9) | the "Saves to" row reads the shared verdict `caseOperationWritePropertyVerdict` and prints through `caseReferenceText` (`caseWritePresentation.ts`; part 04, sections 5.2, 6.1) | the written property's pattern on the case operation tools (part 04, section 13) | `CASE_OPERATION_PROPERTY_REGEX` takes the catalog grammar; `category` and `state` leave the forbidden set (part 04, sections 6.1, 6.2) | the update key as written, in a basic action and a Save to Case block (part 04, section 6) | both alike; the case store holds a hyphenated property (T17) | `case-changes.mdx`, `mcp/tools.mdx` | rows 21 and 34 of part 04's section 2; N2, N7 | none | `.a9` | none |
| A select with one option (A9) | the options editor admits one row (`OptionsEditor.tsx`, `optionsDraftModel.ts`; part 04, section 7.1) | the inline source's `minItems` of one (part 04, section 13) | `SELECT_TOO_FEW_OPTIONS` removed (part 04, section 7.1) | one `<item>` | both alike (T14, T15) | `mcp/tools.mdx` | `questions/multiple-choice-select1-item` (part 04, section 11.1) | none | `.a9` | none |
| Quote marks in a choice value (A9) | the keystroke repair drops no quote; a value with both kinds is refused with its sentence (part 04, section 7.2) | the option value's pattern; the both-quotes rule is a refinement and sends the provider nothing (part 04, section 13) | `SELECT_OPTION_VALUE_PATTERN` is `^\S+$`, less the both-quote-marks class (part 04, section 7.2) | the serializer's literal for either quote (`serialize.ts::literalTokens`; part 04, section 7.2) | both alike: string comparison and `selected()` over tokens (part 04, section 7.2; T14) | `mcp/tools.mdx` | row 33 of part 04's section 2; N6 | none | `.a9` | none |
| Hyphens in a Search field's name (A9) | the name seeded from a property (`case-list-config/seeds.ts`; part 04, section 8) | the name's pattern on `addSearchInputs`, `updateSearchInput`, `configureCaseList` (part 04, section 13) | `SEARCH_INPUT_NAME_PATTERN` (part 04, section 8) | the prompt's key, the `field[@name=…]` read and the locale id (part 04, section 8; T21) | both alike | none | `case-search/name-prompt-key-case-property`; N3 | none | `.a9` | none |
| Hyphens in a lookup tag and column name (A9) | the create-table and add-column dialogs' verdicts; `suggestWireName` unchanged (part 04, section 9.2) | the tag's and the wire name's patterns on the three lookup tools (part 04, section 13) | `LOOKUP_WIRE_IDENTIFIER_PATTERN` and the two database checks of the migration (part 04, sections 9.1, 9.3) | the workbook, the fixture and every read (part 04, section 9.2) | both alike: no name reaches SQL or the evaluator but as a fixture element (part 04, section 9.2) | none | row 19 of part 04's section 2; N4, N5, N24 | none | `.a9` | none |
| Hyphens in a Connect block id (A9) | none of its own: the Connect cards validate through `CONNECT_ID_PATTERN`, so they follow with no builder file changed (part 04, section 10, "Files by pull request") | `CONNECT_ID_FIELD_DESCRIPTION` on `configureConnect` and `updateForm` (part 04, section 13) | `CONNECT_ID_PATTERN` (part 04, section 10) | the block's id as written | Android only, as every Connect app is (part 04, section 12) | `commcare-connect.mdx` | row 35 of part 04's section 2; N15 | none | `.a9` | none |

No cell is empty. Three are "none" by a reading this part makes where the owning part has no
sentence for it, and this section is where each is stated: part 04 has no line-by-line checklist,
so its rows above are assembled from its sections 3 to 10 and 13; part 03 names no public page for
a search with no title, and section 7 here decides it needs none; and part 04 states "both
platforms" only through its documents' declaration (its section 12: "each is declared for both
platforms unless stated"), which run R2 holds on every reader.

The other places of step 5's checklist, for every row: **Postgres**, none but the lookup checks of
A9's migration and the case store's hyphenated property (part 04, T17, T18); **the reference
index**, through `expressionSlotValues` for a calculated value and `mediaRefs.ts` for the Register
action's media, and nothing else; **existing documents**, none migrate (section 5.4); **the billed
check**, H1 for all of them; **proof**, the targeted documents of section 1.1.

## 5. Migrations, the production reads, and no cutover

### 5.1 The four ledgered migrations, in order

Each is a file of `lib/case-store/migrations/`, registered in `migrations/index.ts` in stamp order,
applied by the deploy's own migration Job while the previous revision still serves
(`lib/case-store/CLAUDE.md`), and typed in `lib/db/pg.ts::AppDatabase` in the same pull request.

| Stamp and name | PR | What it changes | Why it is additive, and safe while the previous revision serves | Its test |
|---|---|---|---|---|
| `20261113000000_hq_round_trip_lookup_names` | A9 | On `public.lookup_tables` and `public.lookup_columns`: drops the two unnamed inline checks, found by their text in `pg_constraint`, and adds `lookup_tables_tag_check` (`char_length(tag) BETWEEN 1 AND 32 AND tag ~ '^[A-Za-z_][A-Za-z0-9_-]*$' AND tag !~ '^xml'`) and `lookup_columns_wire_name_check` (the same over `wire_name`, 1 to 255). No table, column or index (part 04, section 9.3) | Every stored row passes the wider checks, so each `ADD CONSTRAINT` validates in one pass over two small tables. The previous revision writes only names both checks accept, and reads a hyphenated name another revision saved as stored text. `down` counts the stored names that fail the earlier definitions and refuses before changing anything where there is one. App Test namespaces made earlier keep the old check, and their journeys carry runtime version 18, which A9's version 19 ends | `lib/case-store/migrations/__tests__/lookupNames.postgres.test.ts` |
| `20261201000000_hq_bring_in_ledger` | B8 | `app_deployments`: `endings`, and `ended` in the state check; a guarded `UNIQUE (id, server, domain)`. `app_deployment_resources`: `server`, `domain`, `released_at`, `ended_by`, `ended_reason`; the trigger function `public.nova_fill_deployment_resource_target()` with its `BEFORE INSERT` trigger; the two target columns filled from the parent row, then `NOT NULL` with a composite foreign key; two CHECKs; `released_at` set on each deleted app's mapping that another live mapping duplicates; a guard that refuses where two live apps still claim one HQ app; the partial unique index `app_deployment_resources_hq_app_claim`. `app_deployment_baselines`: `identity_map_gzip`, `identity_map_source_digest`, `read` in the origin check, `first_publish_changes` with the CHECK that holds it null unless the origin is `read`. The new table `app_deployment_media_paths` with its folded unique index (part 10, section 11; part 09, section 12.3) | Additive in effect: every statement the previous revision runs still passes, its supersede of a mapping statement 7 released among them, which is why the release CHECK holds no clause about `superseded_at` (part 10, sections 5.3 and 11). New columns are nullable or defaulted, the two widened CHECKs admit every stored row, the trigger fills the two columns an older insert leaves out, and the foreign key holds for trigger-filled rows. Statements that take `ACCESS EXCLUSIVE` run under `lock_timeout = '5s'`: a timeout fails the Job with nothing changed, and the Job's failure blocks the deploy. Every statement replays over its own result. Stated, and not hidden: the previous revision cannot read an `ended` deployment or a `read` baseline, which only the new revision can write, so once someone has brought an app in or stopped publishing, a rollback to the previous revision is not a state this plan supports. `down` throws | `lib/case-store/migrations/__tests__/hqBringInLedger.postgres.test.ts` |
| `20261202000000_hq_bring_in_project_data` | B9 | `lookup_tables`: ten nullable `hq_*` columns, the CHECKs `lookup_tables_hq_origin_whole` and `lookup_tables_hq_takeover_attributed`, the partial index `lookup_tables_hq_origin`. `app_organization_state`: eight nullable `hq_*` columns and `app_organization_state_hq_origin_whole`. `app_locations`: `hq_location_id` with its not-blank CHECK (part 11, section 6.1) | Every new column is nullable with no default, so the revision that still serves writes rows that pass every new CHECK, and each `ADD CONSTRAINT` validates over rows whose new columns are all null, under the same five-second lock timeout. App Test namespaces clone the two tables with their constraints, and the seed inserts named columns and never these. A tab on the old bundle parses every lookup manifest frame of a Project with no brought-in table, because the relay leaves `hq` out for a plain table; in a Project that holds one it fails the frame, refetches and reloads onto the new bundle (part 11, section 6.2). `down` drops the index, the constraints and the nineteen columns | `lib/case-store/migrations/__tests__/hqBringInProjectData.postgres.test.ts` |
| `20261203000000_hq_app_readings` | B10 | The one new table `hq_app_readings`, with its five named CHECKs, its column `step_beat_at` (the mark a running step writes every ten seconds, which no CHECK reads; part 12, section 3.2) and the indexes `hq_app_readings_open` (unique, over a person's open reading of one HQ app in one Project) and `hq_app_readings_home` (part 12, section 2.1) | The previous revision never reads the table. Every statement is `IF NOT EXISTS`. `down` drops the table, for local teardown only | `lib/case-store/migrations/__tests__/hqAppReadings.postgres.test.ts` |

### 5.2 The conventions each follows

- **Replay.** Each statement replays over its own result (`IF NOT EXISTS`, `DROP CONSTRAINT IF
  EXISTS` before `ADD`, `CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`), as `lib/case-store/CLAUDE.md`
  asks of every migration.
- **No grant.** No migration grants anything. Grants converge on the next deploy through
  `lib/db/privilegeConvergence.ts`: B8 moves `app_deployment_identities` from the runtime read-only
  class to runtime insert-and-delete, puts `app_deployment_media_paths` in that class, and registers
  `nova_fill_deployment_resource_target` in `EXPECTED_PUBLIC_ROUTINES` (part 10, sections 3.2, 5.1);
  B9 moves no registry entry, its three tables being runtime read-write already (part 11, section
  6.1); B10 adds `hq_app_readings` to `RUNTIME_READ_WRITE_TABLES` (classification `application`,
  capability `read-write`) with one `SELECT … FOR UPDATE` probe in
  `lib/db/__tests__/privilegeConvergence.postgres.test.ts` (part 12, section 2.2).
- **Checked against the previous revision's writers.** Each new CHECK, `NOT NULL` and unique index
  of the four was read against every statement the previous revision runs on its table while it
  still serves, over the rows the migration leaves, and each admits every row that revision can
  write. A9's two checks are wider than the ones they replace (part 04, section 9.3). B8's are
  tabled constraint by constraint in part 10 (section 11, "With the previous revision serving"),
  and one was cut down for it: `app_deployment_resources_release_is_an_apps` is `released_at IS
  NULL OR kind = 'app'`, with no clause about `superseded_at`, because that revision supersedes a
  mapping by setting `superseded_at` alone and can do so to one statement 7 released; B8's
  migration test makes that statement on a released row. B9's three CHECKs read only the `hq_*`
  columns it adds, which that revision writes nowhere, so they are null on its inserts and
  untouched by its updates (part 11, section 6.1). B10's table is one that revision never reads or
  writes (part 12, section 2.1).
- **Order and stamps.** The four sort in pull request order, and section 2.1's restamp rule is the
  only way a stamp moves.
- **Real Postgres.** Each has a `*.postgres.test.ts` that runs `up` over a database holding rows of
  the shape `main` writes, and B8's also holds the CHECK on `first_publish_changes`, the guard's
  refusal, and the previous revision's supersede statement run on a released mapping.
- **No migration adds an entry to `scripts/test-schema.ts::SCHEMA_TESTS`.** That list holds tool
  schemas; its two additions are A7's `setFormSections` and B9's `getOrganization` (section 1).

Two statements of step 6 write existing rows, both in B8's migration and both replay-safe, and no
other statement of step 6 does (part 10, section 11, where the migration is written statement by
statement). Statement 5 fills `server` and `domain` on every existing mapping from its deployment
row: it copies two values the database already holds and changes no meaning. Statement 7 sets
`released_at` on the mapping of an app in recently deleted that another mapping also names, which
is what lets statement 9's unique index build; it changes no live app, and restoring such an app
brings it back with that deployment ended (section 5.3, the B8 row).

### 5.3 The production reads

The only production reads before a merge are read-only scans the person approves (decision 11).
Each runs through `scripts/lib/prodDb.ts`, as the repository's inspectors do, as the
person's gcloud identity; each is asked first with what it reads and prints; none writes; and no
output is committed.

| Read | PR | Command | What it reads and prints | Every outcome |
|---|---|---|---|---|
| A registration form that also creates a same-type child at its root | A5 | `npx tsx scripts/scan-case-list-registration-registrations.ts`, locally first, then with `--prod` | every stored app; it lists each app with a module whose `caseListRegistrationForm` names a form for which `rootBasicSubcaseCreates` holds a create of that module's case type, by app id alone (part 02, section 16) | *None found* (expected: CommCare HQ's build refuses the shape, so no such app has published): A5 merges, and the script is removed in the last commit of A5's pull request, made after its run and before stack A merges. *Some found*: A5 does not merge while one stands, because a stored app the gate refuses stops at its next edit and blocks the deploy's runtime probe. Each is repaired where its author can see it: the author moves the second case into a repeat or another form in the builder. Or, with the person's yes for that app, the repair below stops offering the form through the planner's own clear. The scan runs again until it finds none, and everything the repair added is removed in that same last commit of A5's pull request |
| An HQ app two live Nova apps publish to | B8 | `npx tsx scripts/scan-hq-app-claims.ts --prod` | the live, unreleased `app` mappings grouped by `(server, domain, remote_id)`; it prints two numbers, the groups holding two or more live apps and the groups holding one or none, and with `--list` the app ids of the first kind to the terminal (part 10, "Written and not yet run", G1) | *No group holds two live apps*: B8 merges as written; its migration releases each deleted member of a group and builds the index. *Some group does*: B8 does not merge. The person chooses the app that keeps publishing; every other app of the group is moved to recently deleted in the product, and the scan runs again until the first outcome. After the deploy, restoring one of those apps brings it back with that deployment ended and says so. The migration's guard refuses the deploy where a group is still there. The script leaves in B15 |
| The census | after stack B is live | `npx tsx scripts/inspect-hq-readings.ts --prod` | `state`, `census`, `manifest_revision` and the key columns of every reading, deduplicated to one row an app; it prints three tables of counts (by step 7 group, by entry id, by outcome) and no app id, app name, project space, server, Project or person (part 12, section 8.2) | run H8 of "Written and not yet run" |

**The repair A5's scan can call for.** It exists only on the scan's "Some found" outcome and only
for an app the person said yes to, and it writes a production document the one way the repository
does: as #879 repaired choice starting values
(`scripts/lib/selectStartingValueRepair.ts::migrateSelectStartingValues`;
`docs/architecture/deployment.md`, "Historical repairs").

- **The plan.** The scan, run with `--app <id> --out <path>`, writes that app's entry to a private
  file: the app id, its `mutation_seq`, the digest of the stored document, the module and the form,
  and the digest of the document after
  `lib/doc/caseListRegistrationForm.ts::caseListRegistrationMutations(doc, moduleUuid, formUuid,
  null)`. The person reads it before anything is written.
- **The writer.** `scripts/migrate-case-list-registration-registrations.ts` over
  `scripts/lib/caseListRegistrationRepair.ts` takes the reviewed plan (`--plan <path>` or
  `--plan-base64 <value>`) and is a dry run without `--execute`. For each app it locks the row,
  refuses an app a run or an unsettled reservation holds, refuses one whose sequence or digest
  moved since the plan, and commits one `blueprint-migration` row by the actor
  `system:case-list-registration-registrations` through
  `lib/db/apps.ts::appendSyntheticBatchInTransaction`, with the reason "Stopped offering a
  registration form after an empty search: the form opens two cases of the list's type, which
  CommCare HQ cannot build." A rerun finds the row by its batch id, verifies it and writes nothing.
- **Where it runs.** Locally first, against the local database. In production once, before stack A
  merges, through the fenced Job runner in a maintenance image built from A5's head
  (`scripts/rollout/deploy-cloud-run.py --execute-job --job=commcare-nova-historical-repair`), under
  the migration Job's identity, with the service serving: the lease refusal is what keeps it off an
  app someone is building. No maintenance window is taken.
- **What the author sees.** The app's change history (`app_changes`) holds the row with its
  reason. No notice row is written, as #879's repair wrote none: the person approves each app by
  id, and the app could not build in CommCare HQ as it stood (part 02, section 16).
- **What is left.** Nothing. The last commit of A5's pull request, made after the run and before
  stack A merges, removes both scripts, the library and its test, the two bundle lines of the
  `Dockerfile`'s `maintenance-build` stage, the two arms of the Job runner
  (`deploy-cloud-run.py::_effective_execution_args`) with their cases in
  `scripts/infra/tests/test_deployment_policy.py`, and the paragraph of `deployment.md`. The stack
  merges by squash, so none of them lands on `main`, B15 has nothing of it to remove, and the pull
  request's commits keep the record of what ran. Part 02's section 16 carries these same five
  steps.

The deploy's runtime probe is no scan of this plan: it reruns the gate over every saved app on every
deploy, as today (`lib/db/runtimeDatabaseProbe.ts`), and A5's scan exists so that the probe meets
nothing new.

### 5.4 No document migration, no maintenance window, no notice, no announcement, and no Job as planned

Stated plainly, with why each is safe:

- **No document migration.** Every stored slot stack A adds is optional or a wider grammar, and no
  stored document holds one: `formsInMenuAbove` (part 02, decision 17), the `always` arm (every
  stored arm is `after-empty-search` and parses unchanged; part 02, section 11.1), `keypad`, the
  prose part `value`, the `none` arm of `searchScreenTitle` (absent keeps meaning "Search"; part 03,
  section 6), `blanks`, `plainHelp`, `plainText` (part 03, checklist row 12), and A9's grammars, each
  of which admits every name it admitted before (part 04, decision 14). Stack B adds no document
  slot. So no fold horizon and no transform exist to write, and no `blueprint-migration` row but the
  one 5.3's repair writes for an app it is run for.
- **One rule can newly refuse a stored document**, `several-registrations` on an
  `after-empty-search` form, and A5's scan shows no stored app holds the shape before A5 merges, by
  finding none or by each one found being repaired (5.3). A8's refusal of a `blanks` equal to the
  direction's own meets no stored rule, since none holds the key. A9 removes refusals and adds none.
- **Two things change for an existing app without a migration, and neither is a change a person or a
  worker sees.** From A8 an app's next publish writes no formatted copy for a hint or a validation
  message, which no runtime reads (part 03, section 8.2), so no notice is written. From A9 an App
  Test journey started under runtime version 18 is refused its next step and started again, which is
  what the version is for (part 04, section 3.4).
- **No maintenance window, and no maintenance Job unless A5's scan finds an app.** The four
  migrations are additive and run in the deploy's ordinary migration Job with the previous revision
  serving (5.1). Ownership of a lookup table is derived from the live mappings of the Project's apps
  (part 11, section 10), so the outline's one cutover, merging each table's per-app records, has no
  data to move, no backfill, no scan and no reconcile. On the expected outcome of A5's scan there is
  no maintenance image, no fenced Job, no allowlist arm and no runbook. On its "Some found" outcome,
  and only for an app the person said yes to, 5.3's repair runs once through the fenced Job runner
  with the service serving, and every file it added leaves in the last commit of A5's pull request.
- **No notice and no announcement.** No stored app changes but an app 5.3's repair is run for, whose
  history holds the repair's row and its reason; no notice row is written and `lib/notices` gains no
  reason. Stack A's features appear in the builder where an author meets them; stack B's entry point
  lands with B11 at the top of a stack that merges whole. There is no flag, no lease, no version
  floor, no staged activation and no transitional shim.
- **Forward only, for both stacks.** What holds for each deploy: its migrations are additive and
  safe with the previous revision serving while they run (5.1), and every document saved before
  the deploy loads on either revision, because no stored document migrates. What does not hold is
  a rollback once a stack is in use. Stack A adds stored document slots and wider grammars
  (`formsInMenuAbove`, the `always` registration arm, `keypad`, the prose part `value`, the `none`
  arm of `searchScreenTitle`, `blanks`, `plainHelp`, `plainText`, and A9's hyphenated question ids
  and lookup tags with the rest of its grammars) that the schemas of the revision before stack A
  refuse, so once an author has saved a document that uses one, that revision cannot load the app.
  Stack B's deploy cannot be rolled back to stack A's revision once someone has brought an app in
  or stopped publishing (5.1). A bad deploy of either stack is corrected by rolling forward, as
  with every model addition in this repository; a rollback to the revision before it is not a
  state this plan supports.

## 6. Contract, `CLAUDE.md` and architecture sentences

"Today" is the sentence at `main` `15a00a97`, quoted whole or by its opening words where the
replacement takes the sentence whole; where the source wraps a sentence over lines the quote joins
them with one space. "Kept; adds" means the quoted sentence stays and the new text follows it. A
replacement in quotation marks is the text as written. It names no plan step, pull request, part,
run or finding, because the plan leaves the repository in B15 and a contract file says what is so.
The proof lane's documents and the research's findings are the exception: they name steps and
findings today and keep doing so (section 8).

"PR" is the pull request whose change makes the sentence false. Where a part holds a row's
replacement word for word, the row cites that part's "Contracts and docs these changes make false"
and does not restate it; that part's text is the replacement. Where a part left the wording to A11
or B14, or did not list the sentence, the text is written here and the row says "this part".

### 6.1 The research's contracts table, step 6 rows

The research's "Contracts this work changes" table gives five rows to step 6. Each row's place, or
the reason it stands:

| Research row (contract it quotes) | At `main` | Where step 6 settles it |
|---|---|---|
| `contracts.md`, app birth as a closed vocabulary of two owners, to gain a third, `hq-import` | the research's quote is older: `contracts.md` says "App birth comes from the Builder's explicit blank action, a reviewed architect checkpoint, or an ordinary authoring session's first valid checkpoint. All three use one genesis writer", and `lib/db/CLAUDE.md` holds the closed pair "(`explicit-blank \| design-slice`)" | the owner is `hq-adoption`, the fourth caller of the one genesis writer (part 12, section 6; claim corrected there). `lib/db/CLAUDE.md` in B10; `contracts.md` in B14 (6.4) |
| `contracts.md`: "A durable deployment record is keyed by Nova app, Project, HQ server, and HQ domain." | true | the key stands. A lookup table's standing in a project space is derived from the live mappings of the Project's apps, with no record of its own and no data move (part 11, section 10, Departure 5). B14 adds part 10's and part 11's sentences after it (6.4) |
| `lib/deployment/CLAUDE.md`: "There is deliberately no arm for 'matched by name'" | true | stands unchanged (part 11, Departure 5). B9 adds the two arms that account for a table (a sibling app's mapping; a takeover a person recorded) and the sentence that a tag met at a reading is bound by the review's rule before any app exists, never by a publish. The research's `referenced` ownership value is not built (part 11, Departure 5) |
| `lib/deployment/CLAUDE.md`, when a publish creates afresh | `main` says "A publish creates afresh only when there is no active mapping or the active mapping's `remote_missing_at` is set." | B8: "… only when there is no active mapping (a first publish, or one after the deployment was ended) or …" (part 10, "Contracts"). A person may end any deployment that holds a live app mapping; the research's "whose HQ app no longer reads" is no condition |
| root `CLAUDE.md` (`lib/lookup`): "every export mode carries the data" | true | B14, in part 11's words (6.2): every export mode carries the data Nova manages, and a table brought in from CommCare HQ ships in a second workbook of the HQ app file and is never written where it is managed |

### 6.2 The root `CLAUDE.md`

| Section | Today | From step 6 | PR |
|---|---|---|---|
| the opening paragraph | "Nova turns a natural-language conversation into a working CommCare app." | kept; adds, directly after that sentence and before "A user describes the data they collect", "An app that already lives in CommCare HQ can be brought in and carried on from there." (part 13, "Contracts", which places it there) | B14 |
| "The mental models", item 3 | "CommCare's wire vocabulary is quarantined behind `lib/commcare`, a one-way emission boundary enforced by a Biome import rule." | "CommCare's wire vocabulary is quarantined behind `lib/commcare`, the one boundary that writes it and, for an app brought in from CommCare HQ, reads it, enforced by a Biome import rule." The next sentence, "The SA and the builder never speak CommCare.", stands (this part; part 06 asks that it stand) | B14 |
| the same item | "and where CommCare HQ keeps each published case change and query repeat and which menus it holds as advanced, which a publish records." | "…, which a publish records, or the reading that brought the app in." (part 12, "Contracts") | B14 |
| the same item | "A form's `xmlns` and every HQ menu and form id are derived from the Nova entity's UUID and stored nowhere in the document." | "A form's `xmlns` and every HQ menu and form id are stored nowhere in the document: they are derived from the Nova entity's UUID, except on the project space an app was brought in from, where the deployment ledger holds CommCare HQ's own." (part 10, "Contracts") | B14 |
| "The map", `lib/commcare` | "`BlueprintDoc` → wire (XForm XML, HQ JSON, suite.xml, `.ccz`), the validator and its parse-time oracles" | "`BlueprintDoc` → wire (XForm XML, HQ JSON, suite.xml, `.ccz`) and, in `reader/`, an HQ app back to a `BlueprintDoc`; the validator and its parse-time oracles" (part 06's text for the bullet) | B14 |
| the same bullet | "This is the compile / export / HQ-upload path; the barrel is client-safe and consumers are allowlisted in `biome.json`." | "This is the compile / export / HQ-upload path and the path an app is brought in through; the barrel is client-safe, the reader sits outside it, and consumers are allowlisted in `biome.json`." (this part) | B14 |
| "The map", `proof/` | "over a reproducible corpus of admitted documents" | "over a reproducible corpus of admitted documents and of apps made in CommCare HQ's own pages" (part 14, "Contracts") | A1 |
| the same bullet | "every difference is erased by a proven spelling rule or held by the strict known-defect register (`proof/known-defects.json`), whose entries for a fixed defect move to `proof/fixed-defects.json` and keep showing on its retained control;" | "every difference is erased by a proven spelling rule, held by the strict known-defect register (`proof/known-defects.json`), whose entries for a fixed defect move to `proof/fixed-defects.json` and keep showing on its retained control, or, on an app made in CommCare HQ, named by the first-publish register (`proof/first-publish-changes.json`);" (part 14's "Contracts", which holds the same whole sentence: the clause on `proof/known-defects.json` stays with the register it describes) | A1 |
| the same bullet | "Its checks (the bar, intent, manifest, configuration sensitivity, proofs 1 to 5, every walk held to its end or a held stop)" | "Its checks (the bar, intent, manifest, configuration sensitivity, proofs 1 to 6, parity with Nova's reader, every walk held to its end or a held stop)" (part 14) | B13 |
| "The map", `lib/deployment` | "`preflight → resources → uploaded → built → released → runnable`, with `incomplete` as the refusal that names the phase a retry resumes at." | kept; adds "A project space a person stopped publishing to is `ended`: its HQ app stays, and a later publish there makes a new one." (this part) | B14 |
| the same paragraph | "(a first publish makes the empty app first)" | "(a first publish makes the empty app first, unless the app was brought in from that project space, where it updates the app it came from)" (this part) | B14 |
| the same paragraph | "never writes over a remote resource Nova cannot account for: a name clash refuses and is resolved only by a caller naming the exact resources a person confirmed." | kept; adds "A Project's table is accounted for when any of the Project's apps holds a live mapping for the table CommCare HQ has under that tag." (part 11, "Contracts") | B14 |
| the same paragraph | "Nor does it write over a change made in HQ since Nova's last push without the person confirming the discard" | "Nor does it write over a change made in HQ since Nova's last push, or since it brought the app in, without the person confirming the discard" (this part) | B14 |
| the same paragraph, its end | "Its `CLAUDE.md` is the contract." | kept; adds after it, as the entry's last sentence, part 12's sentence that begins "`lib/deployment/reading` is the other direction: a reading of one CommCare HQ app for one person in one Project," (part 12, "Contracts": "gains, at its end") | B14 |
| "The map", `lib/lookup` | the sentence that begins "every export mode carries the data: local `.ccz` export resolves their current names" and ends "shipped beside the app JSON for a manual import." | part 11's replacement, which begins "every export mode carries the data Nova manages:" and ends "and ships it in a second workbook of the HQ app file." (part 11, "Contracts") | B14 |
| "The map", `lib/db` | "the apps/entity-rows/stream/thread/run/credit/usage/lookup tables," | "the apps/entity-rows/stream/thread/run/credit/usage/lookup tables and the readings of CommCare HQ apps (`hq_app_readings`, written only through `lib/deployment/reading`)," (part 12, "Contracts") | B14 |
| "The map", the builder UI | "`components/builder` (the canvas, flipbook, inspector rail, case-list workspace, media pickers; its doc opens with the three-sources-of-truth state model)" | kept; adds "and `components/bring-in` (the flow that brings an app in from CommCare HQ, a state of `/build/new`)" (part 13, "Contracts") | B14 |

Stack A changes two sentences of the root file, both A1's, in the `proof/` bullet. Everything else
stack A makes true is stated in a subtree file or in `complex-apps.md`, and the root's mental models
stay true of it: a calculated
value in text is one more expression slot under model 4, and what stays CommCare HQ's is stated in
`contracts.md` by A3.

### 6.3 `docs/architecture/complex-apps.md`, stack A (A11)

Part 04 fixes its three texts ("Contracts": the reserved write properties, the case operation
vocabularies, and "at least one fully UUID-identified option" under "Lookup carriers, table
expressions, and itemsets"). Parts 02 and 03 fix the content and leave the wording, which is this:

**"One-tier nested menus", its first paragraph.** Today: "Every module remains independently
runnable with its own native Form or case list, and every Form still has exactly one owning module.
Nova does not author linked forms, shadow modules, deeper menu trees, or HQ's unrelated
`put_in_root` behavior." From A11: "Every Form still has exactly one owning module. A module may
show its forms in the menu above (`Module.formsInMenuAbove`, HQ's `put_in_root`): its forms list on
that screen and it has none of its own. Nova does not author linked forms, shadow modules or deeper
menu trees." (part 02, "Contracts")

**A new subsection under it, "#### Forms in the menu above".** It opens:

> `Module.formsInMenuAbove` is CommCare HQ's `put_in_root` (`ModuleBase.put_in_root`, offered while
> the add-on `menu_mode` is on). The module's forms and its case list entry list on the screen above,
> the app's first menu for a top-level module and its parent's screen for a submenu, and the module
> has no entry and no screen of its own. `lib/domain/menuScreens.ts` is the one statement of which
> screen lists what. CommCare HQ's build does fourteen things with the setting, and Nova writes or
> refuses each:

Then the table of part 02's section 2, its fourteen rows and three columns ("What HQ does",
"Source", "Nova") as they stand there, with "from step 6" dropped from the third heading. Then:

> **Which screen chooses a case first.** Core lists a screen by walking every `<menu>` in suite
> order (`MenuLoader.getMenuDisplayables`), so the forms of a menu that shows above appear in place,
> in module order. For the command a worker chose, Core asks what every entry behind it needs first
> (`CommCareSession.getNeededData`, `getDataNeededByAllEntries`): every entry of every menu with that
> id, a case list entry among them. The case list shows before any form only when each entry needs
> the same case choice first. So `menuScreens.ts::screenChoosesCaseFirst` answers for a screen and
> never for a module alone: the app's first menu lists forms first, since no command is chosen yet;
> a screen that is a bare case list opens on its list; a screen holding a form that opens without a
> case lists forms first; and so does a screen whose contributors choose different cases.
> `lib/commcare/__tests__/screenCaseFirstParity.test.ts` holds that answer to the first datum the
> wire gives every entry.
>
> **No chosen case ahead of a command.** Core keeps what a frame collected (`syncState`), and an
> entry's next question is its first datum whose id the session lacks (`getFirstMissingDatum`). A
> frame that held a chosen case and no command would leave that case on the first menu, where the
> next form that asks under the same datum id would take it without asking. Formplayer rebuilds its
> session from empty (`MenuSessionFactory.rebuildSessionFromFrame`), so Web Apps keeps nothing
> there. Nova writes no such frame: the previous screen is not offered to a form listed on the first
> menu, and a link, an entry point or a Register return that would open with the first menu's shared
> case is refused at its source.

Under part 02's G6 outcome B the last sentence reads "Nova writes no such frame: the previous
screen is not offered to a form listed on the first menu."

**"Register when nothing matches".** Its citation `lib/domain/menuForms.ts::caseListRegistrationFormOf`
reads `afterEmptySearchRegistrationFormOf`. A sibling subsection follows it, "#### Register from the
case list":

> The `always` arm of `Module.caseListRegistrationForm` names a registration form of the module's
> case type that stays on its own menu, and the module's case list offers it at any time
> (`lib/domain/menuForms.ts::alwaysOfferedRegistrationOf`). It is CommCare HQ's `case_list_form` with
> a `form_id` (`models/modules.py::CaseListForm`), the Case List page's "Registration Form
> Accessible from Case List". Nova writes the block for a form that stays on its menu, with no
> synthetic module and no `relevancy_expression`.
>
> **The action.** CommCare HQ's build adds the action to the module's short details when
> `case_list_form.form_id` is set and the module does not show its forms above
> (`details.py::build_detail`), and only where the form holds exactly one registration of the list's
> type, counted over its `open_case` and every root subcase of that type together
> (`Form.is_registration_form`, `Form.get_registration_actions`). The action pushes the form's
> command, its computed datums and `return_to`, the host's menu id
> (`details.py::get_case_list_form_action`). The short detail is shared, so the action shows wherever
> that list shows.
>
> **The return.** Where the form has no after-submit of its own, CommCare HQ writes return frames
> that fire only under that `return_to` (`workflow.py::CaseListFormWorkflow`). `case_list` returns to
> the host's screen with no case chosen. `default` lands in the host's menu with the new case
> chosen, or on the host's screen where the form created none. Where the form has its own
> after-submit, CommCare HQ writes no return frame and the worker goes there from the list too; the
> arm's `afterSubmit` stays stored and applies again once the form's own returns to Home
> (`menuForms.ts::caseListRegistrationReturnOf`).
>
> **What is refused**, each by `lib/commcare/validator/rules/case-search/caseListRegistration.ts`:
> a form that is missing (`CASE_LIST_REGISTRATION_FORM_NOT_FOUND`); a form that is no registration
> form of the host's type, or holds more than one registration of it
> (`CASE_LIST_REGISTRATION_NOT_REGISTRATION`); a host that shows its forms above
> (`CASE_LIST_REGISTRATION_HOST_SHOWS_FORMS_ABOVE`); a host some form of which needs no case
> (`CASE_LIST_REGISTRATION_HOST_NOT_CASE_FIRST`); and a host or a named form in an advanced menu
> (`CASE_LIST_REGISTRATION_ADVANCED_MENU`).
>
> **The button by platform.** Web Apps draws the action's text alone
> (`cloudcare/partials/case_list/list.html`); commcare-android draws its image and plays its audio
> (`views/EntityActionViewUtils.java`). The platform row `case-list-registration-media` states it.

**A new section after "Form sections", "### Question display and text"**, four paragraphs, from part
03's sections 3.1, 4.4, 5 and 8.1:

> **The Phone Number question.** A Text question holding `keypad: "numbers"` is the form builder's
> Phone Number or Numeric ID question (`src/mugs/types/text.js::PhoneNumber`): `<input
> appearance="numeric">` with bind `xsd:string`, read back as that question exactly when the bind is
> a string and the appearance is the whole string `numeric` (`parser.js::buildControlNodeAdaptorMap`),
> and typed `PhoneNumber` by CommCare HQ's question summary (`xform.py::VELLUM_TYPES`). The answer is
> text on every reader, so a leading zero and a plus sign are kept. Core keeps the appearance and
> reads nothing from it. Web Apps draws its phone entry where `numeric` is one of the appearance's
> tokens and stores an answer only where it matches `^[+-]?\d*(\.\d+)?$`
> (`form_ui.js::getMatchingStyles`, `entries.js::getEntry`). Android builds its string-number widget
> where the whole appearance equals `numeric` or `numbers`, with a keypad of the digits, a period, a
> dash, a plus and a space (`WidgetFactory.java::buildBasicWidget`). The platform row `number-keypad`
> states the difference, and `lib/commcare/xform/appearance.ts` is the one writer of a control's
> appearance.
>
> **A calculated value in text.** A prose part `{ kind: "value", expression }` is an `<output
> value>` holding any form-rule expression. Core reads each output of a text as an expression of its
> own (`XFormParser.java::parseOutput`), evaluates it at the question's node
> (`FormDef.java::fillTemplateString`) and prints the result by XPath's string rule
> (`XPathConditional.java::evalReadable`): a date as its ISO day, a number as XPath prints it, yes or
> no as `true` or `false`. Formplayer and Android show Core's text. A value that only reads one
> reference is stored as that reference, so one meaning has one stored form. In a validation message
> a value is composed as it stands, with no `count` guard: Core's `count` takes a node-set alone
> (`XPathCountFunc.java::evalBody`), and Core answers an error raised while it composes a message
> with the expression's own text. The form builder shows an output whose text matches its date
> pattern as a date chip and any other output as written, and keeps both on save
> (`richText.js::extractXPathInfo`, `outputToBubble`).
>
> **Text CommCare HQ reads as an instance.** CommCare HQ's build searches the whole rendered form
> for instance reads, labels included, by a text pattern (`xform.py::XForm.add_missing_instances`,
> `suite_xml/post_process/instances.py::get_instance_names`). For a name the form does not declare it
> adds the instance where it knows the name and refuses the build otherwise. So literal label text
> that holds `instance('x')` is written with its bracket as a literal output, `<output
> value="'('"/>`, after the word (`lib/commcare/hqInstanceScan.ts::instanceScanCuts`, the cut the
> serializer already makes inside a string literal). A worker reads the same characters, and the
> text stays one `text` part in the document.
>
> **Text shown as typed.** Who reads a text's formatted copy (`<value form="markdown">`) differs by
> text and by platform. A label: Android and Web Apps both format where the copy exists and show the
> text as typed otherwise (`QuestionWidget.java`; `caption_markdown`). An inline choice: Android the
> same, while Web Apps formats every choice. A help text: Android formats where the copy exists
> (`QuestionWidget.java::createHelpLayout`), and Web Apps formats the default text always
> (`form_ui.js::Question.prototype.fromJS`). A hint: Android shows it as typed always
> (`QuestionWidget.java::addHintText`), and Web Apps formats the default text always. A validation
> message: as typed on both (`FormEntryPrompt.java::getConstraintText`). So `plainLabel`, `plainHelp`
> and a form's `plainText` each leave the copy out, a hint and a validation message never write one,
> and a form holding `plainText` carries `vellum:ignore="markdown"` on `h:html`, the form builder's
> Disable Text Formatting (`core.js::showFormPropertiesModal`). The form builder writes a copy only
> where it loaded one or the text looked like formatting (`javaRosa/plugin.js::contributeToModelXML`,
> `loadXML`), so a text Nova writes without one stays without one through a save there.

The Android clause of the first paragraph is part 03's G5 outcome A; outcomes B and C take the note
that outcome writes. The third paragraph is not written under G2's outcome B. Under G4's outcome B
the fourth drops `plainHelp` and says a help text follows the rule of a hint.

**Under "Case lists, search, and the case workspace", after "The search workflow"**, two paragraphs,
from part 03's sections 6 and 7:

> **A search with no title.** `searchScreenTitle: { kind: "none" }` is a search with no title;
> absent means "Search". CommCare HQ's Case List page writes `title_label` for every language on
> every save, blank where nothing was typed
> (`views/modules.py::_gather_and_update_search_properties`); the app string is that text or empty
> (`models/case_search.py::CaseSearch.get_search_title_label`), written into the locale file as a
> non-breaking space (`commcare_translations.py::dumps`); and the suite's `<title>` names that locale
> at CommCare 2.53 and later (`feature_support.py::enable_case_search_title_translation`). Web Apps
> trims it and draws the heading only where something is left
> (`formplayer/menus/views/query.js::templateContext`), and Android draws no search title at all. So
> Nova writes `title_label` blank for every language and the `<title>` over a blank locale.
>
> **Where blanks sort.** A sort rule's `blanks` is `first` or `last`, stored only where it differs
> from the direction's own, first ascending and last descending. CommCare HQ's sort rows offer the
> choice with that default (`sort_rows.js`; `views/modules.py::_init_new_sort_element`) and copy it
> to the suite's `<sort blanks>` (`detail_screen.py::sort_node`). Core reads `first` or `last`,
> falls back to the direction otherwise (`DetailFieldParser.java::parseBlanksPreference`), and
> places a blank by that alone, whatever the direction (`EntitySorter.java::getCmp`). Both platforms
> read it alike.

### 6.4 The architecture files, stack B (B14)

**`docs/architecture/contracts.md`.**

| Section | Today | From step 6 | Owner |
|---|---|---|---|
| "Delivery discipline", app birth | "App birth comes from the Builder's explicit blank action, a reviewed architect checkpoint, or an ordinary authoring session's first valid checkpoint. All three use one genesis writer" | "App birth comes from the Builder's explicit blank action, a reviewed architect checkpoint, an ordinary authoring session's first valid checkpoint, or bringing an app in from CommCare HQ. All four use one genesis writer" | part 12 |
| the same, after "its session-to-app mapping and exact checkpoint receipt commit with the app." | (none) | part 12's sentences that begin "`hq-adoption` is an app brought in from CommCare HQ: it is born `complete` from the reader's construction batch, with no holder, reservation, credit or design session." | part 12 |
| the same | "the starter UUIDs); a persisted empty app, optional seed path, independently reconstructed starter, or pre-app placeholder row is forbidden." | "the starter UUIDs, and on a brought-in app only, where it came from); a persisted empty app, optional seed path, independently reconstructed starter, or placeholder `apps` row is forbidden. A design session and a reading (`hq_app_readings`) are records of work toward an app and are never an app." | part 12 |
| "Locations and restore scope", first paragraph | "Organization structure lives partly in the blueprint and partly in app-scoped rows, so mutations and row writes share the app-row lock discipline." | kept; adds part 11's sentences that begin "An app brought in from CommCare HQ whose logic reads places holds them as a copy that project space manages:" | part 11 |
| "HQ deployment safety" | "A durable deployment record is keyed by Nova app, Project, HQ server, and HQ domain." | kept; adds part 10's sentences that begin "One HQ app is published to by one Nova app at a time, across Projects." | part 10 |
| the same bullet | "Remote-resource mappings additionally key the Nova resource UUID and store ownership/adoption, remote id, pushed identity, and revision." | kept; adds part 11's "A lookup table's standing in a project space is the Project's: a publish reads it from every app of the Project that holds a live mapping for the table CommCare HQ has under the tag, so a second app publishes the Project's own table without being asked to take it over." | part 11 |
| the same | "Nova never auto-adopts a same-named HQ resource, overwrites an unowned resource, or deletes a remote resource on rename." | kept; adds part 11's "A table or a set of places managed in CommCare HQ is never written in the project space that manages it. Manage in Nova is the one way a person hands such a table to Nova, and it is recorded on the table with who and when." | part 11 |
| the same | "Nova never writes over a change made in CommCare HQ since its last publish there without a person's word." | "Nova never writes over a change made in CommCare HQ since its last publish there, or since it brought the app in, without a person's word." | part 10 |
| the same | "by comparing HQ's current read of the app, each mapped lookup table and each mapped place with HQ's own read after Nova's last push" | "… with HQ's own read after Nova's last push, or the read the app was brought in from" | part 10 |
| the same, the placement bullet | "are held from the publish that first carries them" | "are held from the publish that first carries them, or from the reading that brought the app in" | part 12 |
| the same bullet | "Only a publish or a migration records or replaces a hold that can still express what it holds;" | "Only a publish, a migration or bringing the app in records a hold, and only a publish or a migration replaces one that can still express what it holds;" | part 12 |
| the same bullet | "puts it back where the publish recorded it" | "puts it back where it was last recorded" | part 12 |
| the same, a new bullet after the placement bullet | (none) | part 09's bullet that begins "The first publish over an app brought in from CommCare HQ changes only what `FIRST_PUBLISH_CHANGES` declares," | part 09 |
| "One Postgres system" | "Lookup definitions and rows are Project-scoped." | kept; adds part 11's "A table records where in CommCare HQ it came from and who manages it; an app's organization state records the same for its places." | part 11 |

The paragraph "**Some of an app stays CommCare HQ's.**" after "Nova is not CommCare HQ." is A3's
(part 01, "Contracts"), lands in A3, and B14 leaves it as it is.

**`docs/architecture/complex-apps.md`.**

| Section | Today | From step 6 | Owner |
|---|---|---|---|
| a new subsection, "How CommCare HQ rewrites a display condition and a filter" | (none) | the table of part 08's section 6.1 (slot, call, case path, dots) and its sentence that begins "HQ replaces these as text, inside string literals too," | part 08 |
| case search, after the sentence that begins "A search reads `today()` as the worker's day: Nova sends Core's `today()` in a" | (none) | "CommCare HQ's own `today()` in a search is the project space's day. An app brought in that uses it reads as Nova's `today`, and its first publish says the day is now the worker's." | part 08 |
| "Export, publishing, and the deployment record" | "An adoption is never inferred: the publish REFUSES, names the resource, and only a caller naming that exact Nova id records it, attributed to who and when." | kept; adds "An app is `adopted` by one route alone, bringing it in from CommCare HQ, which records who did. A Project's lookup table is accounted for in a project space when any app of the Project holds a live mapping for the table CommCare HQ has under that tag, so a second app publishes it without being asked." | this part |
| the same section | "The `project-data`, `organization`, and project-space compatibility edges talk to HQ during preflight, each appearing only when the app carries that thing;" | "The `managed-data`, `project-data`, `organization`, and project-space compatibility edges talk to HQ during preflight, each appearing only when the app carries that thing. `managed-data` comes first: it reads the lookup tables CommCare HQ manages for the app, refreshes Nova's copy where only rows changed, and stops the publish where something the app reads is gone;" | this part |
| a new section after it, "### Bringing an app in from CommCare HQ" | (none) | the text below | this part |

> An app that lives in CommCare HQ comes in as an ordinary Nova app exactly when a document and
> ledger rows exist such that the document passes the absolute gate and export readiness; publishing
> it back changes nothing a runtime, CommCare HQ's servers or existing data read, apart from the
> first-publish changes Nova declares; reading Nova's own emission of it gives the same document; and
> every item of the HQ app's source has one standing in the surface manifest. There is no partial
> bring-in: an app Nova cannot hold whole is answered with every finding it met, and nothing is
> created. `lib/commcare/CLAUDE.md` ("The reader") and `lib/deployment/CLAUDE.md` ("Readings",
> "Accepting a reading", "One HQ app, one Nova app", "Ending a deployment") own the detail. The
> binding facts:
>
> - **Two requests, one reading.** The stored source and the application resource share no revision
>   (`ApplicationBase._meta_fields`, `Application.export_json`), so a reading brackets them with the
>   app's version read before and after, and reads again where it moved
>   (`lib/commcare/hq/appReading.ts::readHqAppForReading`).
> - **A form's own id needs API access.** The source read serves a freshly minted id for each form
>   (`models/applications.py::Application.scrub_source`, through
>   `app_manager/util.py::update_form_unique_ids`), and the application resource serves the stored
>   one (`api/resources/v0_4.py::ApplicationResource.dehydrate_module`). So bringing an app in needs
>   API access on the project space, checked when the space is chosen and again at the read
>   (`lib/commcare/hq/apps.ts::probeHqApiAccess`).
> - **CommCare HQ's ids stay on the project space they came from.** A brought-in app's menu ids,
>   form ids and `xmlns` are rows of `app_deployment_identities`, and its media paths rows of
>   `app_deployment_media_paths`, for that project space alone. Every other project space, and the HQ
>   app file, take Nova's derivation (`lib/commcare/wireIdentity.ts::targetWireIdentity`).
> - **Spelling is free; behavior is declared.** Nova writes every form in its own spelling. What a
>   first publish changes beyond spelling is the closed register
>   `lib/deployment/reading/firstPublishChanges.ts::FIRST_PUBLISH_CHANGES`, drawn from
>   `lib/commcare/emissionRewrites.ts::EMISSION_REWRITES`, and the proof lane holds the predicted set
>   equal to the observed one on every app made in CommCare HQ (`proof/first-publish-changes.json`).
> - **One HQ app, one Nova app.** A unique index over live app mappings holds it across Projects
>   (`lib/db/hqAppClaims.ts`).
> - **Project data comes in as copies CommCare HQ manages.** The lookup tables and places an app
>   reads are read for Preview and validation, refreshed before a publish, and never written in the
>   project space that manages them (`lib/lookup/CLAUDE.md`, "Tables from CommCare HQ";
>   `lib/organization/CLAUDE.md`).

**`docs/architecture/deployment.md`.** After the opening paragraph's "App, docs, and MCP public
probes finish the deployment.", part 12's sentence: "The deploy names the service's memory
(`--memory=2Gi`), because reading an app from CommCare HQ divides an instance's memory between the
worker that checks the app and the rest of the server (`lib/deployment/reading/budget.ts`): the
figure is checked in, and every deploy holds the service to it." And after "probe checks every saved
app with the incoming validator.", part 12's sentence: "An app brought in from CommCare HQ is a
saved app like any other and passed this gate at its birth, so a rule that tightens ships its scan
over saved apps first, and that scan meets shapes only CommCare HQ's editors author."

**`docs/architecture/multilingual-localization.md`.** Today: "CommCare's localized maps and
resources exist only at the one-way `lib/commcare` emission boundary." From B14: "CommCare's
localized maps and resources exist only at the `lib/commcare` boundary, which writes them on
emission and reads them when an app is brought in from CommCare HQ." (this part)

### 6.5 The subtree `CLAUDE.md` files and the lane's documents

Every row below lands in the pull request named, with the behavior that makes its old sentence
false. The text is the owning part's, in its "Contracts and docs these changes make false".

| File | Pull requests, and what each changes | Owner |
|---|---|---|
| `lib/commcare/CLAUDE.md` | A2 (three sentences of "The surface manifest": `subject`, `owner`, the derived standing); A3 (the kept paragraph; "Runtime request destinations", three sentences; the seventeen profile properties; the `<meta>` block's location capture); A4 ("Ordinary nested menus", "After-submit links", "`post_submit` defaults"); A5 (the two case list registration paragraphs); A7 (literal text read as an instance); A8 ("Markdown itext", the case list order's blanks); A9 ("Typed FormPath", the generated-node paragraphs, "Form reads", "Vellum dual-attribute pattern"); B1 (five sentences of "CommCare HQ project-space compatibility", the readers sentence, and the new subsection "Reading an app from CommCare HQ"); B2 (the opening, the manifest's five readers, the new section "The reader", and the two "one-way" sentences below); B3 (the reader's second paragraph, `tryParseXml`'s failure kind, `generatedBaseName`); B4 ("Reading case management back", the after-submit reader sentence, the "Not-yet-modeled" line); B5 (the `reader/caseList` sentence); B6 (the `reader/search` sentence; "Reading expressions"); B7 ("Rewrites"); B8 (the kept-profile clause for a brought-in app; the media paragraph's held path); B13 (the coverage sentence) | parts 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 14; part 06 and this part for the two sentences below |
| `lib/commcare/xpath/CLAUDE.md` | A9 (the record type's reference text); B6 (`sourceProjection`'s second caller, `FormParseScope.reading`, the reader's recognition) | parts 04, 08 |
| `lib/commcare/xpath/wire/CLAUDE.md` | B6 (`rewrites`; `literalTokens` exported) | part 08 |
| `lib/domain/CLAUDE.md` | A4 (four sentences on screens and case first); A5 (the two arms); A6 (the typed display vocabulary); A7 (the prose part `value`, its projector); A8 (a sort rule's blanks, a search with no title, the three plain settings); A9 (the question id grammar, the choice value's bound, the record type's reference text, the keystroke repair, a write property's grammar) | parts 02, 03, 04 |
| `lib/domain/expression/CLAUDE.md` | A7 (`ProseSlotRef` as a calculated value's context); B6 (`instantTextOfMicros`; and "CommCare names and wire function spelling are provided at the one-way emission boundary." becomes "CommCare names and wire function spelling are provided at the `lib/commcare` boundary.") | parts 03, 08; this part for the last |
| `lib/doc/CLAUDE.md` | A4 (two bullets); A5 (the registration slot on remove and move); A9 (the question id grammar); B2 (`planDeclarationChoices`) | parts 02, 04, 06 |
| `lib/preview/CLAUDE.md` | A3 (fuzzy search in case lists); A4 (a new section, and two sentences on a hidden target); A5 (the `always` arm); A6 (`rules.numberKeypad`); A8 (`rules.plainHelp`) | parts 01, 02, 03 |
| `lib/preview/app-tests/CLAUDE.md` | A9 (runtime version 19) | part 04 |
| `components/builder/CLAUDE.md` | A3 (the kept list on the Publishing card); A4, A5 (one bullet each); A6, A7, A8 (the field editor's sentence, as each leaves it); A9 (one option, the keystroke repair); B10 ("Creation never navigates"); B11 (one sentence after B10's; `router.refresh()`; the drift stop's third way; where a brought-in app came from) | parts 01, 02, 03, 04, 12, 13 |
| `components/CLAUDE.md`, `lib/routing/CLAUDE.md`, `e2e/CLAUDE.md` | B11 | part 13 |
| `lib/agent/authoring/CLAUDE.md` | A7 (two sentences on `{{= formula}}`); B6 (`list(...)`); B12 (the guide's one paragraph on a brought-in app) | parts 03, 08, 13 |
| `lib/export/CLAUDE.md` | A3 (`targetFacts`); B7 (`boundaryFindings.ts`); B9 (the managed workbook) | parts 01, 09, 11 |
| `lib/deployment/CLAUDE.md` | A3 ("Baselines", a fourth bullet of what the record answers); B1 (the build ids row); B4 ("Placements"); B7 ("Accepting a reading"; the baseline's first-publish list); B8 ("Ownership" three times, "Identities", "Baselines", "Preflight is a graph", the state machine's `ended`, the two new sections "One HQ app, one Nova app" and "Ending a deployment", the endings fence; and part 01's sentence of "One publish lifecycle"); B9 (`managed-data` and `plan-features` in "Preflight is a graph", the two ownership arms, the handed-back window, worker provisioning, the failure code); B10 (the new section "Readings"); B12 ("Surfaces") | parts 01, 05, 07, 09, 10, 11, 12, 13 |
| `lib/db/CLAUDE.md` | B8 (the two insert-and-delete tables, the baseline's column, the cascade sentence, the second partial index, `restoreApp`, the lock order); B10 (the closed birth owner's third member, `adoptHqAppInTransaction`, two lock-order sentences, the paragraph on `hq_app_readings`, the placement paragraph) | parts 09, 10, 12 |
| `lib/media/CLAUDE.md` | B8 (a held wire path); B9 (staged bytes with no row; `validateSniffedMediaBytes`) | parts 10, 11 |
| `lib/lookup/CLAUDE.md` | A9 (the name grammar); B9 (the write's purpose, the birth's lock order, predeclared ids, the new section "Tables from CommCare HQ", the workbook sentence) | parts 04, 11 |
| `lib/organization/CLAUDE.md` | B9 (the writer's purpose and `managed.ts`; the three refusals for managed places) | part 11 |
| `lib/collab/CLAUDE.md` | B10 (the third way a receipt arrives; the cross-scope receipt) | part 12 |
| `proof/CLAUDE.md`, `proof/README.md` | A1 and B13 (part 14's rows); a targeted document's sentence in the pull request that adds it; B1 (two places on the `reading/` group); B6 ("Native proofs") | parts 02, 03, 04, 05, 08, 11, 14 |
| `docs/testing.md` | B3 (the `scale` project) | part 06 |
| `design/readme.md` | B11 ("Bringing in"; the `RadioGroup` contract row) | part 13 |

**"One-way", wherever the package is called it** (section 12.3; part 06's "Contracts" and part
09's "Contracts" carry these same rows). Part 06 takes "One-way emission boundary" out of
`lib/commcare/CLAUDE.md`'s opening in B2. Two more sentences of that file, two source comments and
the Biome rule's message say the same, and each is true only of import direction: nothing of
`lib/commcare` but its tests imports `lib/deployment`, by `rg` at `main`.

| Where | Today | From step 6 | PR |
|---|---|---|---|
| `lib/commcare/CLAUDE.md`, the opening's last sentence | "A Biome `noRestrictedImports` rule enforces the one-way direction." | "A Biome `noRestrictedImports` rule holds who may import it." | B2 |
| `lib/commcare/CLAUDE.md`, "capture URL node" | "from the caller (`lib/deployment/attachmentTarget.ts`), because the emission boundary is one-way;" | "from the caller (`lib/deployment/attachmentTarget.ts`), because `lib/commcare` imports nothing of the deployment layer;" | B2 |
| `lib/commcare/xform/captureUrlNode.ts`, the header of `AttachmentUrlTarget` | "because `lib/commcare` is a one-way emission boundary: the deployment layer may read the wire package, never the other way round." | "because `lib/commcare` imports nothing of the deployment layer: the deployment layer may read the wire package, never the other way round." | B2 |
| `lib/commcare/xpath/index.ts`, the header comment | "the package's \"one-way emission boundary\" rule is scoped to wire-format emission (XForm XML, HqApplication JSON)," | "the package's import rule (`biome.json`) is scoped to the wire formats (XForm XML, HqApplication JSON)," | B2 |
| `biome.json`, the four messages of the rule on `@/lib/commcare` | each opens "lib/commcare is the one-way CommCare emission boundary." | each opens "lib/commcare is the CommCare boundary, the one package that speaks CommCare's wire vocabulary." The list of allowed consumers that follows is part 09's | B7 |

B2 changes no line of `biome.json`, as part 06's section 2.4 holds; the message moves in B7, the one
pull request of stack B that edits those four strings (part 09, "Contracts"), and the stack merges
whole, so no deployed revision carries the old sentence beside the reader.

Every other source comment and header a part rewrites lands with its code and is in that part's
"Contracts" table.

**Files with no step 6 change**, each read for a sentence step 6 could leave false:
`lib/agent/CLAUDE.md` (its rule on the version literal is the one this plan follows, and its one
sentence on registration from the case list stays true; part 02, checklist row 15),
`lib/agent/change-set/CLAUDE.md`, `lib/agent/workspace/CLAUDE.md`, `lib/case-store/CLAUDE.md`,
`lib/case-store/sql/CLAUDE.md`, `lib/codemirror/CLAUDE.md`, `lib/log/CLAUDE.md`,
`lib/session/CLAUDE.md`, `lib/ui/CLAUDE.md` and `scripts/infra/CLAUDE.md`.

## 7. Public docs, by page

Every sentence follows `design/readme.md`, "Content fundamentals": it invites, takes responsibility,
offers the next step, uses sentence case and no em dash; a control's name is bold and in the
builder's words. The feature is "bring in", never "import", which keeps naming the CommCare HQ app
file and CSV replacement (the top-level file, "What changed from the outline, and why", item 13).
Each sentence has one owner, and a text a part writes word for word is cited and not restated. A
link is written in its page's own style. No sentence names a private HQ flag, a client's app or a
project space by name.

Public docs land in A11 and B14, with one recorded exception: A3 lands its own three pages, because
its `KEPT_AT_HQ` cells and its export advisories point at the section it writes (part 01, sections
5 and 9.7).

### 7.1 Stack A

| Page | What changes | Text | PR |
|---|---|---|---|
| `publishing.mdx` | a new section "What stays as it is in CommCare HQ" | part 01, section 9.7 ("Some of an app's settings are CommCare HQ's to keep: …") | A3 |
| `building-with-nova.mdx`, "Preview on Web Apps and Android" | one paragraph on required-question asterisks and fuzzy search in Preview's case list | part 01, section 9.7 | A3 |
| `mcp/tools.mdx`, the `refresh_deployment` and `get_deployment` rows | `kept_values` and `deployment.kept` | part 01, section 9.6 | A3 |
| `nested-menus.mdx` | a new section "Show a menu's forms in the menu above" | part 02, "Contracts" (one paragraph, which begins "A menu can show its forms in the menu above.") | A11 |
| `display-conditions.mdx` | two sentences on a menu that shows its forms above | part 02, "Contracts" | A11 |
| `form-links.mdx`, "Which destinations a form is offered" | three sentences on **Module**, **Parent menu** and **Previous screen** | part 02, "Contracts" | A11 |
| `deep-links.mdx`, "Choose a destination" | "A menu that shows its forms in the menu above takes no deep link of its own; link to one of its forms." | part 02, "Contracts" | A11 |
| `case-workspace.mdx`, after "Register when nothing matches" | a new section "Register from the list" | part 02, "Contracts" (one paragraph, which begins "A case list can offer a registration form at any time,"; under part 02's G3 outcome C it holds one sentence more, "On a menu whose forms read the search, only **Back to this list** is offered.") | A11 |
| `where-workers-use-your-app.mdx` | the row "Icon and spoken label on Register: in Web Apps the button shows its text only." | part 02, section 13 | A11 |
| the same page, after "…records the device's location on Android." | two sentences, on a phone number question and on a help text shown as typed, in the wording part 03's G5 outcome gives | part 03, "Contracts" | A11 |
| `building-with-nova.mdx`, "Text in your app" | two sentences, on a calculated value and on turning **Format text** off | part 03, "Contracts" | A11 |
| `mcp/tools.mdx`, the `update_module`, `get_module` and `set_menu_media` rows | `forms_in_menu_above`, `register_from_case_list`, the new read keys, the target `case-list-registration` | part 02, "Contracts" | A11 |
| the same page, the wording paragraph; the `add_fields` and `get_field` rows; the column `sort` paragraph | `{{= formula}}`; "`field_list`, `plain_label`, `plain_help` and `keypad` where set"; `blanks` | part 03, "Contracts" | A11 |
| the same page, three sentences | a choice value's characters; "An inline source carries at least one option"; "Write-property names start with a letter and can also hold hyphens." | part 04, "Contracts" | A11 |
| `commcare-connect.mdx`, "IDs" | "starts with a letter, uses letters, digits, underscores and hyphens, and is 50 characters or fewer" | part 04, "Contracts" | A11 |
| `case-changes.mdx` | "…; saved property names start with a letter and can also hold hyphens." | part 04, "Contracts" | A11 |

A search with no title has no public sentence: no page describes a search's title, the switch's own
line says what it does (part 03, "Copy"), and `mcp/tools.mdx` lists no description of
`searchScreenTitle` to correct. A11 adds none.

### 7.2 Stack B (all B14)

| Page | What changes | Text |
|---|---|---|
| `bringing-in-from-commcare-hq.mdx` (new), `meta.json`, `index.mdx` | the page, listed after `"building-with-nova"`, and its line in the index | part 13, section 17.1 (ten sections, with part 08's sentences C13 and C14 in its items 5 and 6) |
| `building-with-nova.mdx`, "Start with a blank app" | one paragraph that links the new page | part 13, section 17.2 |
| `publishing.mdx`, the opening | "An app you brought in from CommCare HQ publishes back to the app it came from." | part 13, section 17.2 |
| `publishing.mdx`, "On CommCare HQ" | before "Publishing again **updates this same app in place**": part 13's sentence "For an app you brought in, this card is there from the start, and its first publish updates the app it came from.", then part 09's paragraph that begins "The first time you publish an app you brought in, Nova lists what will differ in CommCare HQ:" | parts 13, 09 |
| the same section | "The one exception: if the app was deleted on CommCare HQ since Nova put it there, …" becomes "There are two exceptions. …", the second being a project space someone stopped publishing to | part 10, "Contracts" |
| the same page, "Each publish keeps every menu's and every form's ID in CommCare HQ." | gains two sentences on a brought-in app's IDs | part 13, section 17.2 |
| `publishing.mdx`, "Changes made in CommCare HQ" | "An app you brought in from CommCare HQ starts from what it held when it came in."; and the paragraph "**You can also stop publishing here.** …" | part 10, "Contracts" |
| `publishing.mdx`, "What stays as it is in CommCare HQ" (A3's section) | "An app you brought in from CommCare HQ keeps these settings exactly as it had them, including the ones it never set. Nova fills in its own defaults only on an app it created there." | part 01, section 9.7 |
| `publishing.mdx`, a new section after "Changes made in CommCare HQ" | "Lookup tables and places managed in CommCare HQ", below | this part, in part 11's words P1 and P2 |
| `project-space-compatibility.mdx`, "Plan features" | three sentences on features a brought-in app was already using | part 13, section 17.2 |
| `case-workspace.mdx`, "Cases assigned to the person using the app" | "an imported app" and "the imported rule" become "an app you brought in from CommCare HQ" and "the rule it came with" | part 13, section 17.2 |
| `projects.mdx`, "When a move waits" | one sentence on a brought-in app that reads lookup tables | part 13, section 17.2 |
| `claude-code/commands.mdx` | "eight `/nova:*` commands"; the flow's sentence; a new section "Bringing in an app from CommCare HQ"; two sentences of `/nova:upload_to_hq` | part 13, section 17.2 |
| `claude-code/quickstart.mdx` | "…as a new HQ app, or back to the HQ app it was brought in from." | part 13, section 17.2 |
| `project-data.mdx`, "What happens to a table when you publish" | the bullet's two added sentences; the cell-character sentence; the second workbook's sentence | part 11, "Contracts" |
| `project-data.mdx`, a new section before "Who can do what" | "Tables managed in CommCare HQ", below | this part, in part 11's words T1 to T3, T9, T11, T16 |
| `organization.mdx` | each of its two sentences on publishing places gains "except places managed in CommCare HQ, which Nova copies and never changes there" | part 11, "Contracts" |
| `organization.mdx`, a new section after "Places" | "Places managed in CommCare HQ", below | this part, in part 11's words O2, O3, O7 |
| `mcp/tools.mdx` | a new section "Bringing in an app from CommCare HQ" with its three rows and callout; `stop_publishing`; the `get_deployment`, `upload_app_to_hq` and `check_project_space_compatibility` rows | part 13, section 17.3 |
| `mcp/tools.mdx`, "Record queries use expressions such as…" | "An app brought in from CommCare HQ can hold `list(...)` in a search condition: several values, any one of which matches. It reads back as written and can be kept, not added or changed." | part 08, "Contracts" |
| `mcp/tools.mdx`, Project data and Organization | four rows, below | this part, from part 11's section 12.4 |

**`publishing.mdx`, "Lookup tables and places managed in CommCare HQ".**

> Before a publish, Nova checks the lookup tables CommCare HQ manages for the app. When nothing the
> app reads is missing, Nova sends none of them and refreshes its own copy. When a table changed in
> CommCare HQ in a way the app depends on, such as a column it reads being removed, Nova stops before
> sending anything and shows you what changed. [Project data](/docs/project-data) and
> [Organization](/docs/organization) say what "managed in CommCare HQ" means for a table and for
> places.

**`project-data.mdx`, "Tables managed in CommCare HQ".**

> When you bring an app in from CommCare HQ, the lookup tables it reads come with it, marked
> **Managed in CommCare HQ**. Each one lives in its project space on CommCare HQ. Nova keeps a copy so
> your apps and Preview can read it, and never changes it there.
>
> You can change the table on CommCare HQ's Lookup Tables page, then choose **Refresh from CommCare
> HQ** on the table's page in Nova. Nova refreshes its copy before each publish too, and the page
> shows when the copy was last refreshed. While CommCare HQ manages a table it stays read-only in
> Nova, for you, for Nova in chat and for an MCP agent alike.
>
> **Manage in Nova** hands the table to Nova. From then on you change it in Nova, and each publish
> to that project space replaces the table there with Nova's columns and rows. If someone changes it
> in CommCare HQ after that, your next publish there stops and shows you what changed before it
> sends anything. A Project admin can choose this, and Nova names the apps that read the table
> before you confirm.
>
> **Let CommCare HQ manage it again** hands it back. Nova takes CommCare HQ's columns and rows as
> they are right then and stops changing the table there. Changes made in Nova that were never
> published there are replaced, and every column becomes text, as CommCare HQ holds it.
>
> If a column your apps read is gone in CommCare HQ, Nova keeps the column in its copy, with no
> values, so those apps keep opening. Their next publish to that project space stops until the
> column is back in CommCare HQ or the apps stop reading it.

**`organization.mdx`, "Places managed in CommCare HQ".**

> When an app you brought in from CommCare HQ reads places, its places come in as a copy. They live
> in the project space on CommCare HQ. Nova keeps the copy so Preview can show them, and never
> changes them there.
>
> You can add or change places in CommCare HQ, then choose **Refresh from CommCare HQ** in
> Organization. Nova refreshes the copy before each publish too. Levels and place information stay
> yours to change in Nova.
>
> CommCare HQ doesn't tell Nova which levels hold workers or how far a worker's phone carries places.
> Nova assumes every level holds workers and each worker carries their own branch. If your project
> space is set up differently, you can match it in Organization so Preview shows what workers see.

**`mcp/tools.mdx`, four rows.**

| Where | Text |
|---|---|
| the `get_lookup_tables` row | gains "A table with `managed_in_commcare_hq` (`project_space`, `refreshed_at`) is a copy of a table that lives in CommCare HQ: read it freely. Its rows and columns change in CommCare HQ, and changing them here is refused." |
| the `get_organization` row | gains "`places_managed_in_commcare_hq` (`project_space`, `refreshed_at`) says the places are a copy of CommCare HQ's: levels and place information can still be changed, places cannot." |
| a new row, `refresh_managed_data` | "Read a lookup table (`table_id`) or an app's places (`app_id`) of the Project (`project_id`) again from the project space that manages them, and answer what changed. Give exactly one of `table_id` and `app_id`. Requires `nova.hq.write`." |
| a new row, `set_lookup_table_management` | "Hand a lookup table (`table_id`) of the Project (`project_id`) to Nova (`managed_by: \"nova\"`) or back to CommCare HQ (`\"commcare-hq\"`). With `confirmed: false` it answers what the change does and which apps read the table, and writes nothing; show that to the user and ask before sending `confirmed: true`. Requires `nova.hq.write`." |

## 8. The research and proof documents, stale manifest cells, and the step 7 rewrite

### 8.1 What this plan's own pull request changes

It is docs and one path inside one source comment, and merges beneath stack A:

- **`docs/plans/hq-round-trip/6-bring-in.md` and `6-bring-in/`**, this plan. The same pull request
  removes the outline this plan replaces, so no file links it. `6-bring-in.md` names the outline's file
  once, near its top, with where it can still be read (`main` at `15a00a97`); every other file of the
  plan says "the outline" and, where it helps, "item N of the outline".
- **`lib/agent/authoring/printQueryExpression.ts`**, one comment, in the default arm of
  `queryPrinter`'s value switch. It named the outline by its path; the pull request changes that
  path to `docs/plans/hq-round-trip/6-bring-in.md` and nothing else of the line, so the comment
  cites a file that exists and `git grep -l '6-import' -- . ':!docs/plans' ':!docs/research'`
  returns nothing from this pull request on. It changes no behavior and no test. B6 rewrites the
  comment whole when it changes the code under it (part 08, "Contracts", C8), which names no plan
  file, so B15's check below finds nothing.
- **`docs/plans/hq-round-trip/7-rest-of-model.md`**, rewritten (8.4).
- **`docs/plans/hq-round-trip/README.md`**. The opening says "brings in" and that step 6
  has no cutover and ships as two deploys. Step 6's row names this plan as planned in full, in
  place of the outline, and links no outline; step 7's row says its first group and how the rest
  are ordered. In "Step 3 is done", "Step 4 is done" and "Step 5 is done", each "left to later
  steps" bullet names the outline's item (8, 9, 10), links `6-bring-in.md`'s section "What changed
  from the outline, and why" as where step 6's plan settles it, and keeps its `7-rest-of-model.md`
  link; and "Step 4 is done" says "step 6's proposed declaration". "Rules every plan follows" gains
  the rule "One name for bringing an app in"; its rule "One cutover per step" becomes "At most one
  cutover per step" and gains that step 6 has none and ships as two stacks with two ordinary
  deploys, with the reason (the top-level file, "What changed from the outline, and why", items 11
  and 25); and its sentence on the pins names step 6's plan among those read at them.
  "Nova since the research" gains the baseline this plan reads (`main` at `15a00a97`: step 5's plan
  and stack, #832 and #837 to #855, after `2f985ed6`, and what merged after them), and its closing
  paragraph what step 5 and #878 did to the research's defects. B14 edits "proofs 1 to 5" in "Step 1
  is done", and B15 rewrites the three bullets again and writes "Step 6 is done" (section 16).
- **`docs/research/2026-09-26-hq-round-trip/harness-findings.md`**, a new heading "Found while
  planning step 6" between "Found while planning step 5" and "Found of the lane itself". It is
  written from the fourteen parts' "Executed during planning" and from this part's: each claim of
  the research, of a manifest cell or of a source comment that a part corrected at source, one
  sentence each with its evidence; the defects of today's Nova found on the way (label text read as
  an instance, part 03; Preview's list filter not folding accents, and a publish seeding fifteen
  absent settings as forced, part 01; `publishedCaseBlocks` passing over a form it cannot read, part
  07); and, in each bullet a gated run still settles, the run and what each of its outcomes means
  for the bullet, with a closing paragraph, "Gated runs that write here", for the three runs no
  bullet names. The heading and every bullet are this pull request's, the ten facts part 05 lists
  among them (part 05, "The harness findings").

**The one rule for a stack pull request and `harness-findings.md`.** It adds no heading and no
bullet. It records a gated run's outcome there exactly where the outcome is not A and corrects a
claim the research states under that heading: then the pull request that holds the run writes the
outcome into the bullet, or the closing paragraph, that names the run. An outcome the bullet
already describes as the expected one writes nothing. These are all the runs that can write there,
each said the same way in its own part's outcome row, and `harness-findings.md` promises no other:

| Run | PR | The outcome that writes | Where under "Found while planning step 6" |
|---|---|---|---|
| G2 of part 03, label text read as an instance | A7 | B (the entry is removed) or C (the spelling that landed, or that the entry stands with no fix) | finding 76 |
| R2 of part 04, over `targeted-hyphenated-question-ids` | A9 | a reader cannot read an authored hyphenated id | "Hyphenated question ids are sound on the wire and not in three of Nova's derivations" |
| R2 of part 04, over `targeted-lookup-names` | A9 | HQ's upload, restore or build, or Core's read, fails on a `-` | "A lookup tag or field name holding `.` has no spelling in the slots HQ rewrites" |
| R2 of part 04, over `targeted-case-type-names` | A9 | either fallback row | "`menus-and-case-lists/modulebase-case-type` gives one grammar where HQ has two" |
| R2 of part 04, over `targeted-case-write-names` | A9 | HQ's case processing and Core disagree about a saved `state` or `category` | "`category` and `state` are ordinary properties on a device too" |
| R2 of part 04, over `targeted-choice-values` | A9 | a reader shows a difference for a value holding a quote mark | "A quote mark in a choice's value breaks no literal" |
| G1 of part 05, a superuser's key | B1 | B | "A superuser's API key does not reach the plan check as a superuser" |
| G2 of part 05, a `RemoteApp` | B1 | any outcome under which the retained source read answers a source and not the failure | "Planning's own first readings", the sentence on a `RemoteApp` |
| G4 of part 05, mirror menus, a report menu and a shadow form | B1 | B or C | "HQ's source read serves more than the reader's comments say" |
| E1 of part 08, `cond` | B6 | C | "A function call in a record slot is more than a Postgres compiler" |
| E1 of part 08, a lexical row and the casedb `name` step | B6 | B; D where the step reads blank or throws | "Gated runs that write here" |
| R1 of part 11, a replacing upload | B9 | B | "Gated runs that write here" |
| R2 of part 11, a reference with no file | B9 | B, C, D or E | "A media reference with no file draws differently by slot, not by platform alone" |
| G1 of part 07, a form builder save of Nova's Save to Case shapes | B13 | C | "Gated runs that write here" |

### 8.2 The proof lane's documents

`proof/README.md` and `proof/CLAUDE.md` move with the lane, in the pull request whose change makes a
sentence false; part 14's "Contracts" holds every row for A1 and B13 (six sources, proofs 1 to 6,
"Apps made in CommCare HQ", "First-publish changes", "Parity with Nova's reader", the accepted
seams, "Changing a pin", "Timings", and decision 17 of "Step 1's decisions"). Each targeted
document's sentence joins "Targeted documents" in the pull request that adds the document (parts
02, 03, 04, 11, 14). B1 adds two sentences on the `reading/` group (part 05), B6 the new native
tests (part 08). These documents name steps and findings, as they do today.

One sentence of `proof/README.md`, which part 14's "Contracts" carries beside its other B13 rows: under
"Native proofs", "to the structural intent checks, and to proofs 1 to 5." becomes "to the structural
intent checks, and to proofs 1 to 6." in B13, because from B13 proof 6 reads back every Nova-born corpus
document, the native families' among them (part 14's run P5). H5's first command reads the file for it.

### 8.3 Manifest cells that name a stale fact

Each was found by a part reading the cell against source, or by this part's `rg` for a step named in
a cell. The entry and its inventory row change together.

| Entry | What its cell says | Correction | PR |
|---|---|---|---|
| `application-and-settings/multimedia-map` | names `bundle.ts::buildMultimediaMap`, which no longer exists | the emission cell as part 01's section 3.3 words it | A2 |
| `forms-and-case-writes/xmlns-form-json-and-xform-data-node` | a widen to a stored `Form.xmlns` slot | `slotChanges: []` and part 10's cell: derived, or the ledger's row on the project space the app came from | A2 |
| `project-space-setting/Domain.commtrack_enabled` (`gates.json`) | its `content` ends "; import asks the same from step 6" | the clause is removed; bringing an app in asks no confirmation, and the first publish asks as today | A2 |
| `application-and-settings/32-features-credentials` | no reader of the profile's `<credentials>` | Android's work history reads it; the emission cell is rewritten (part 01, section 3.6) | A3 |
| `menus-and-case-lists/put-in-root-display-only-forms` | the slot `Module.showFormsInParent` | `Module.formsInMenuAbove` (part 02, section 14) | A4 |
| `questions/phone-number-xsd-string-appearance-numeric` | "`text` with `Field.appearance: numeric`" | "a Text question with `keypad: \"numbers\"`" (part 03, section 10) | A6 |
| `case-search/title-label-or-blank-hq-s-default` | "step 7's migration writes \"Search\" as the title of each such module" | no migration: absent keeps meaning "Search"; the cell reads "`title_label` blank for every language" (part 03, section 10) | A8 |
| `questions/help-text-markdown-form` | "Nova always writes the markdown form, so Android always renders help as markdown" | "…, markdown on (markdown off is `plainHelp`)" (part 03, section 10) | A8 |
| `menus-and-case-lists/modulebase-case-type` | "the editor's ASCII `^[\w-]+$`", silent on Nova's reserved names | the page's check and the server's, as part 04's section 11.1 words them | A9 |
| `expressions-and-data/tag-or-field-name-with-non-ascii-letters-or-starting-xml-in-any` | a dotted name is held verbatim everywhere | HQ's build rewrites or refuses one; the split of part 04's section 11 | A9 |
| `menus-and-case-lists/6-late-flag-late-flag-1` | HELD, as if Nova wrote a late flag column | Nova writes none; re-cut to HELD-NEW (part 07, Departure 1) | B5 |
| `case-search/input-date` | "scalar `date`" | split by what HQ's own matcher compares (part 07, Departure 3) | B5 |
| `expressions-and-data/a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map` | "Android shows its missing-media placeholder" | true only inside a form and a case list image column; split into an INERT and a REFUSED entry (part 11, section 13.1) | B9 |
| `expressions-and-data/a-media-reference-with-no-file-on-a-slot-android-s-install` | "with `appSettings.multimediaValidation` on" and "from step 7, which holds both, the validator refuses the combination" | "where the project space's media check at install is on (`cc-content-valid` other than `yes`, kept at CommCare HQ's value)"; the step 7 clause leaves (part 11, section 13.1) | B9 |

`expressions-and-data/search-input-results-read-in-the-search-results-detail` names step 7 in its
cell and stands: step 7 keeps its number and the entry keeps its owner, `case-list-and-detail`.

`forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held` is no row of
this table. Its cell, "not HQ-editable: no editor writes basic `case_preload` (the basic Case
Management page has no load section)", names a fact that stands at the pin: the basic page's
`case-config:case-transaction` template draws no load, and the load template is drawn by
`case_config_advanced.html` alone (part 07, "Claims corrected"; part 14, "Executed during planning").
B4 re-cuts the entry from REFUSED to HELD-NEW all the same, with subject `case-preloads` and owner
`forms-and-case-management`, on the ground part 07's Departure 9 gives: HQ's save keeps a stored
basic preload and HQ's build writes it, so "CommCare HQ will not save or build this" is false of it,
and what is missing is Nova's. The new cell keeps the sentence about the page (part 07, section 14),
and `harness-findings.md` takes no bullet for it, because no claim of the research, of the outline
or of a manifest cell is corrected.

### 8.4 The step 7 rewrite

`7-rest-of-model.md` keeps its file and its number (the top-level file, "What step 7 is left"). Its
groups are the ten ids every HELD-NEW entry's `owner` names, with `changes-made-in-hq` first and the
rest in the outline's order until the census of run H8 orders them. What step 6's parts hand each group:

| Group | Handed to it, with the part that hands it |
|---|---|
| `changes-made-in-hq` | bringing CommCare HQ's changes in at the drift stop; taking CommCare HQ's version where Nova has not changed; drift judged as the difference of two readings, with `canonDocument`, `canonicalExpression` and `generatedDifference` (parts 08, 09); a hint before a publish when CommCare HQ's copy moved since Nova last saw it, and merging where both sides changed, with only a conflict asked of the person (`7-rest-of-model.md`, group 1, "The three-way comparison" and "A hint before publish"); the first production reader of the baseline identity map, and what a deployment whose baseline holds none is offered (part 10, section 10); what a deployment whose baseline is `unread` is offered, which `7-rest-of-model.md` states as one open question with what is known on each side (its group 1, question 13; part 10, Departure 5); a publish over an HQ app that gained a mirror menu since Nova last read it (part 05, section 7); taking an organization over, and the lookup drift stop's second answer (part 11, sections 9, 11.4); a header chip and a check on open (part 13, Departure 12); `hq-side.json` extended with content edits and a `merges` outcome, on `readForLane` and `withRetainedHq` (part 14, Departure 8) |
| `project-data-at-hq-size` | a table tagged `types`, field properties, multi-valued cells, row attributes, tables that are not global, everything over a lookup cap, media and places over Nova's limits, `place-not-holdable`, `owner-rule-needs-one-place` (part 11, section 13); reading a table's attributes (part 05, section 10.2); N4, N5, N24 (part 04) |
| `settings-nova-comes-to-own` | non-empty build profiles, `features.dependencies`, case sharing with the user groups fixture, grid menus, a form's own location capture, generated translation keys Nova cannot fold (part 01, section 11); a language code Nova's registry cannot name (part 06, section 6.3) |
| `question-display` | every appearance beyond the number keypad, by the nine rules, the registry and the one writer of part 03's section 2, with its section 2.4 table; per-language media on every carrier at once (part 02, section 11.8); a text whose languages show different values (part 06, section 12.5) |
| `case-list-and-detail` | detail tabs, tiles and the remaining column formats; a column the list does not carry, which step 6 holds as hidden from the list and declares as `detail-only-columns-searched` meanwhile (part 07, Departure 7); a flag column with no list header; N10 to N13 (part 04); functions in a record slot and a relation through an index other than `parent` (part 08) |
| `menus` | the eight shapes of registration from the case list part 02's section 11.9 keeps, the previous screen for a form listed on the first menu, a frame through a first menu that shares one case, the case list menu item's media target for the tools, a link to a mirror menu (part 02); a case list label that is empty (part 07); N9, N14 (part 04) |
| `case-search` | the seven search entries of part 07's section 14, a search on a menu that shows its forms above (part 02), a title blank in some languages (part 03); a project space's day in a search, a search value that queries device data, a filter the record rule set refuses, an editable card for a list of values (part 08); N3, N8 (part 04) |
| `forms-and-case-management` | stored case selections for an advanced form, the preload order (a basic and an advanced preload alike), saving only a changed answer off a follow-up form's own update, the tag and index name grammars (part 07, section 14); the question of what, if anything, is step 7's half of the research's contract row on a form's type; a record slot reading a session value the dialect cannot spell (part 08); N2, N7 (part 04) |
| `xform` | the three question kinds part 03's section 2.4 places and part 01's Appendix A.1 gives this group (the acknowledge question, face capture, the Android app callout), with the callout kind `question-display` needs for its one reference; a Save to Case question at an authored position (part 07); model iteration by the load-time rule, a Hidden Value's own bind type, an app that is both a learn and a deliver app, a data root named other than `data` (part 06); the form rule set's wider vocabulary, M3 (part 08); N6, N15 to N23 (part 04) |
| `second-project-space` | updating an existing copy of the app in another project space, which the review and the Publish dialog state meanwhile (part 13, the review's sentence V21c and the Publish dialog's D7) |

`changes-made-in-hq` and `second-project-space` own no manifest entry, and no finding carries
either: a reading meets neither (part 01, section 2.3).

## 9. The nova-plugin check

`../nova-plugin` is its own repository. Its build, edit and autobuild skills and its autonomous
agent send the model to `get_agent_prompt` and `get_authoring_guide`, which Nova serves and which
change with each deploy; what a deploy can leave false is a sentence a skill states in its own
prose. So the sweep is by claim, never by a search for a tool's name.

### 9.1 Stack A

The claims to sweep, as the parts list them: that every menu has its own screen, and that
registration from a case list needs a search (part 02, section 12); a sentence that teaches the
wording syntax, "`{{name}}` inserts an answer", and that wording is always Markdown (part 03,
checklist row 16); a question setting, which no skill names (part 03); and an identifier grammar,
of which the plugin states none, its one hyphen sentence being a project space's slug (part 04,
section 13). At `0a67203` the sweep finds no such sentence (section "Executed during planning", 7).

Run H4 repeats it at A10's head. With nothing found, stack A has no plugin pull request and
`plugin.json` stays at `2.4.2`.

### 9.2 Stack B

One pull request, planned in part 13's section 16, in `skills/` and in its mirror under
`.dev-plugin/skills/`:

- **A new skill**, `skills/bring_in/SKILL.md`, invoked as `/nova:bring_in [project space] [app
  name]`, with part 13's twelve steps: it never chooses the Project, the name, where the app runs,
  the date-and-time split or a table's answer for the user, and never offers to bring in part of an
  app.
- **The `upload_to_hq` sweep, by claim**: the frontmatter's "The first upload to a project space
  creates the HQ app" and the confirmation's sentence, each of which gains the app a brought-in app
  came from; the tables and places that "go up with it", which become the ones Nova manages; the
  paragraph that relays `first_publish` before the confirmation (part 13, section 16.2, words it and
  has the skill relay it in the confirmation's message, before the yes; part 09, section 12.2,
  defines the value); the `hq_changed` bullet's "since Nova last published it", which gains "since it
  was brought in" and `stop_publishing` (part 10); a new `publishing_stopped` bullet (part 10); the
  sentence on `kept` and `kept_values` (part 01, section 11); and the report line for
  `deployment.ending`.
- **The versions**: `.claude-plugin/plugin.json` from `2.4.2` to `2.5.0`, a new skill being a minor,
  and `.dev-plugin/.claude-plugin/plugin.json` from `1.31.0` to `1.32.0`; where H4's outcome B moved
  either for stack A, each is the next minor from what it then holds.
- **`README.md`**: one line for `/nova:bring_in` under "Skills".

It is opened beside B12, against the tool text B12 ships, and merged only after the deploy that
carries stack B is confirmed live (section 3, rules 10 and 13): a skill that names a tool the server
does not serve yet fails at its first call. Run H4 sweeps the plugin again at B12's head for the
claims above. B14's description carries the pull request's link, and B15 writes it into "Step 6 is
done".

## 10. Every gated run, in one table

Each part writes its runs' outcomes in full under "Written and not yet run"; this table is the
stack's checklist, with each outcome named by where it lands. "Asks" is who must say yes before the
run starts: a run in a pull request's own CI asks no one; a dispatch by hand, a billed call and a
production read are each asked of the person first, every time. No heavy run is made on the
person's machine, as "Written and not yet run" says. What runs in the implementer's shell is light:
the free sweeps and hash runs (H2, H4, H5), part 04's R1 (a parser generator, seconds), A5's scan
against the local database, and H1 and E1, each a handful of single requests on a yes. Every lane
slice, reader, native family and scale test goes to GitHub's runners, asked first.

### 10.1 Stack A

| Run | Part | PR | Where it runs | Asks | Outcomes, and where each lands |
|---|---|---|---|---|---|
| P1, the probe | 14 | A1 | `proof-audit.yml`, `mechanics=hq-plain`, every reader, by hand once A1's CI is green | the person | A: nothing. S (two spellings every reader reads alike): a spelling rule with its proof, in A1. B (an emission gap): the shape leaves `bases/plain.py`, A1 merges, and the pull request that owns it (A8 for text, A7 for prose, A3 for a setting, A4 or A5 for a menu, A9 for a name, A2 otherwise) fixes it, adds it back and repeats P1 at its head. C1 (a change Nova's spelling makes on purpose, of a kind part 09's section 11.2 lists): an entry of `proof/first-publish-changes.json` in A1 under part 09's id. C2 (any other change a runtime reads): a HELD-NEW entry in A2 and a variant in B13. H: a member of `HQ_OWN_REPORTS`, in A1. W: the walk is taught in A1, or a walk stop names `hq-plain`. A1 does not merge until a run's gate passes |
| P7, A made again | 14 | A1 | its own CI, `proof/matrix/test_remade.py` | no one | A: equal. B: the retained `app.json` is written after one `wrap` round. C: the unit's arm saves through `save_doc` |
| Run 1, the `.ccz` mirror | 01 | A3 | the lane with the readers over `targeted-kept-values`, by hand | the person | no difference: section 5's cells stand. A profile property, an app string, `PostURL` or the `<credentials>` block differs: the named function is fixed in A3. A key section 4 calls inert is written by HQ's build: its row moves to kept, in A3. A difference no row names: the key is put to the kept test in A3, and becomes TARGET-OWNED with a row or not-yet with owner `settings-nova-comes-to-own`. No register entry under any outcome |
| Run 2, Core's fuzzy match | 01 | A3 | its own CI, the native family `expression` | no one | every vector agrees: the test stays as control. One differs: `lib/preview/listFilterMatch.ts` is corrected in A3 |
| G1, HQ's build against the local suite | 02 | A4, A5 | each pull request's own CI (proof 3, the manifest check) | no one | A: nothing. B: `compiler.ts` or `formLinkProjection.ts` is corrected to HQ's bytes in the same pull request, with a unit test |
| G2, the served readers' walks | 02 | A4, A5 | `proof-audit.yml`, `mechanics=<the five ids>`, by hand | the person | A: nothing. B: a walker is taught in the pull request whose document stopped it. C: the landing is corrected in `screenOfFrame` or `alwaysOfferedRegistrationReturn`, with a `different` reading and a Preview cell where the two platforms then differ |
| G3, the Register return | 02 | A5 | its own CI, `RegisterFromListRuntimeTest` | no one | A: as planned. B: `CASE_LIST_REGISTRATION_MULTIPLE_RETURN` stops applying to the `always` arm, and one entry and its lane reader are not added. C: one new code, the choice disabled in the builder, one HELD-NEW entry with owner `menus`, all in A5, and one sentence more in A11's `case-workspace.mdx` section |
| G4, case first against the wire | 02 | A4 | ordinary CI, `screenCaseFirstParity.test.ts` | no one | A: equal. B: `screenChoosesCaseFirst` is corrected to the wire's answer. A4 does not merge with the two unequal |
| G6, the first menu's shared case | 02 | A4 | its own CI, `MenuScreensRuntimeTest` | no one | A: the refusals stand. B: A4 lands without the three shared-case refusals and adds `targeted-forms-in-menu-above-shared-case`; A5 and B4 each leave out one entry |
| The A5 scan | 02 | A5 | section 5.3: locally, then production, read-only | the person | none found: A5 merges and the script leaves. Some found: A5 does not merge while one stands; each is repaired by its author in the builder or, on the person's yes for that app, by section 5.3's repair through the fenced Job runner, which leaves no file behind |
| G5, Android's number keypad | 03 | A6 | the lane's Android reader over `targeted-number-keypad`, by hand | the person | A: the note stands. B or C: `numberKeypadTyped`'s rules and the Android note take what the read shows, and A11's sentence takes that outcome's wording. Written into A6 before the stack merges |
| G1, the form builder keeps a calculated value | 03 | A7 | proof 4 in its own CI, and once by hand with the editors | the person, for the run by hand | A: nothing. B: one code with its exported predicate, one REFUSED entry, the output moved to that rule's control, in A7; B6 claims the entry by that predicate (part 08, section 9.2). C: the spelling rule `prose-output-spelling` with its proof, in A7 |
| G2, label text read as an instance | 03 | A7 | its own CI, `proof/hq/test_label_instance_text.py` | no one | A: section 5 lands, and the two controls stay as the evidence of finding 76. B: section 5's change is dropped and A7 removes finding 76. C: the quote mark is written as a literal output too, or the change is dropped and the label joins the Connect text issue; A7 writes which into finding 76 (section 8.1) |
| G3, each runtime prints a value as Preview does | 03 | A7 | its own CI, the native family `expression` | no one | A: nothing. B: Preview's evaluator is corrected to Core's text. C: the `count` wrapper is removed, or one code with its exported predicate and one REFUSED entry are added, in A7, and B6 claims the entry by that predicate (part 08, section 9.2) |
| G4, plain help on a device | 03 | A8 | the lane's Android reader over `targeted-plain-help`, by hand | the person | A: stands. B: `plainHelp`, its switch, its input and its entry leave A8. Written into A8 before the stack merges |
| R1, the grammar generator | 04 | A9 | `scripts/build-xpath-parser.ts` in A9's working tree, as its first step (seconds, no test) | no one | A: section 5 lands. B: `hashtagName` heads the token precedence list. C: a third external token `hashtagSegment` in `hashtagGuard.ts` |
| R2, the names' documents | 04 | A9 | two dispatches of `proof-audit.yml` by hand: the eight ids, then the Connect receiver slice | the person | each document passes, or the one grammar it holds falls back as part 04 writes (the row becomes HELD-NEW with its owner, and that grammar is not built); five fallback rows correct a bullet of `harness-findings.md` in A9 (section 8.1). A9 does not merge until both have run |
| H1, stack A's billed check (part 02's G5 inside it) | 15 | A10 | the implementer's shell, one `npm run test:schema -- <name>` a name | the person, once | "Written and not yet run": every request passes and stack A deploys `.a9`; a refused schema is corrected in A10, the literal moves to `.a10` and that one entry is asked again; a no leaves A10 unmerged |
| H2, H3, H4: the contract sweep, the docs build, the plugin sweep | 15 | A11, A10 | free reads and A11's own CI | no one | "Written and not yet run": silent; or each hit is fixed in the pull request whose behavior made it false; a plugin sentence stack A makes false gets its own pull request |
| H6, stack A's exit | 15 | after the merge | section 11.1: `main`, the first night, the deploy | no one | "Written and not yet run": every row holds and stack B opens; or the failing row is fixed forward and checked again |

### 10.2 Stack B

| Run | Part | PR | Where it runs | Asks | Outcomes, and where each lands |
|---|---|---|---|---|---|
| G1 to G7, HQ's answers to the reads | 05 | B1 | `proof-slice.yml` over `proof/hq/test_retained_reads.py`, by hand, on B1's branch before it opens | the person | each answer is retained under `proof/hq-reads/reading/` and B1's code is written for outcome A. G2's B moves the `remote` arm, and its C removes it with the code `remote-app`; G3's B adds the `not-summarized` reading, which part 12 maps to `app-unreadable-in-hq`; G4's C reads through G3's arm; G5's B takes the header's wait; G7's B drops `table-rows-unreadable`; G1 decides one sentence of `lib/commcare/CLAUDE.md`; G1's B, G4's B or C, and a source that answers for G2's `RemoteApp`, each correct a bullet of `harness-findings.md` in B1 (section 8.1) |
| R1, a form builder save and generated nodes | 06 | B3 | its own CI, `vellumSavedSource.test.ts` | no one | A: stands. B: the rule gains the saved spelling as a second accepted tree, in B3. C: B3 stops; the emitter is corrected in a pull request of its own against `main` with a retained control, and stack B is rebased onto it |
| R2, the reader at Nova's ceiling | 06 | B3 | `reader-scale.yml`, by hand | the person | A: at or under 20 seconds. B: B3 gains a memo of a generated node's expected tree before it merges, and the run is made again |
| G4, the entry facts over the corpus | 07 | B4 | ordinary CI, `entryFacts.corpus.test.ts` | no one | A: equal. B: the key joins the fact lists in B4. B4 does not merge with an unequal list |
| G2, an excluded Search field no filter reads | 07 | B5 | ordinary CI, `excludedField.test.ts` | no one | A: as written. B: one HELD-NEW entry in B5, raised from B6 |
| E1 to E4, the spelling, interpolation, CSQL and `current()` vectors | 08 | B6 | its own CI, the native families `expression` and `csql` | no one | each A: nothing. E1's B, C, D: a rule narrows in `syntaxCompare.ts`, each written into `harness-findings.md` in B6 (section 8.1; D only where the `name` step reads blank or throws). E2's B or C: `hqInterpolation.ts` or the emitter is corrected in B6. E3's B or C: a refusal or a binder arm in B6. E4's B: `default-reads-current` becomes a declared, worker-touching change, which B7's register holds |
| E5, read-back over the fuzz corpus | 08 | B6 | ordinary CI, `expressionReadBack.fuzz.test.ts` | no one | A: nothing. B: a pair joins `PRINT_COLLISIONS`. C, D, E: a fold, a canonical row or a claim is added in B6, which does not merge with one open |
| G1, the duplicate-claim scan | 10 | B8 | section 5.3: production, read-only | the person | A: B8 merges. B: B8 does not merge until the scan answers A |
| R1, a replacing upload and an unnamed table | 11 | B9 | its own lane run, `proof/views/test_lookup_upload.py` | no one | A: the test stays as control. B: B9 does not merge as written; the refusal `managed-table-shares-the-space` lands, recorded in `harness-findings.md` in B9 (section 8.1) |
| R2, a reference with no file on each platform | 11 | B9 | `proof-slice.yml`, the Android and Web Apps readers over `targeted-missing-media`, by hand | the person | A: section 3 stands. B to E: the slot that outcome names moves between the drawn and the inert side for that platform, with the two entries' `item` cells, in B9, which also corrects the bullet of `harness-findings.md` that outcome contradicts (section 8.1) |
| K1, the canon list is complete | 09 | B7 | its own CI, `canonReadBack.fuzz.test.ts` | no one | A: nothing. B: the pair joins `CANONICALIZATIONS` in B7. C: the owning reader module is corrected in its own pull request, and B7 does not merge with it open |
| K2, HQ's type rows | 09 | B7 | `proof-slice.yml` on B7's branch, by hand | the person | A: the port agrees and the file is committed. B: `HQ_TYPE_ROWS` is corrected in B7 |
| K4, acceptance fits its budget | 09 | B7 | `reader-scale.yml`, by hand | the person | A: at or under 40 seconds. B: check 2 reduces the batch once, and the run is made again. C: the largest of 125, 100 and 75 forms that fits becomes the stated ceiling in B7; where 75 does not fit, stack B does not merge and the person is told |
| M1, the check fits its memory | 12 | B10 | `reader-scale.yml`, by hand | the person | A: both checks of an app at the ceiling K4 left answer under the worker's heap limits, and the server's share of the two bodies peaks at or under 512 MiB: nothing lands. B: a check ends on its heap limit: neither the heap nor the service's memory is raised, the run is made again at the sizes of K4's ladder below that ceiling, and the largest that fits becomes the stated ceiling in B10, the smaller of K4's and M1's standing; where 75 does not fit, stack B does not merge and the person is told, with the peaks. C: the checks answer and the server's share is over 512 MiB: part 05's `HqAppReading` loses `application` in B10, so the resource's menus are held once, and the run is made again; still over, the size comes down as in B |
| E1, stack B's billed check (part 08's E7 inside it) | 13 | B12 | the implementer's shell, `npm run test:schema -- getLookupTables` and `-- getOrganization`, and one more for each further name the hash run gives (section 3, rule 7) | the person, once, as B12's first act | A: every entry passes, recorded in B12's description. B: the description or schema is corrected in B12 and that entry is sent again on a fresh yes. C (no, or not now): nothing is sent and B12 is not merged |
| P2, every base with every reader | 14 | B13 | `proof-audit.yml`, two dispatches of eleven and twelve bases, by hand, before stack B merges | the person, each dispatch | A: nothing. S, H, W: as P1, in B13. R (the reader read A wrongly): the claiming reader pull request (B3 to B6) is amended. B (an emission gap): fixed in B7 beside its rewrite site. C1: a `FIRST_PUBLISH_CHANGES` entry in B7, and stack B does not merge until the person has read its sentence. C2: the claiming pull request re-cuts the entry to not-yet and the shape moves to a variant. D (a starter app reads as an account): stack B does not merge; where the finding names a concept no stack A pull request built, the person is told before anything merges |
| inside P2: G3 (part 07), E6 (part 08), G2 (part 10), K3 (part 09), Run 3 (part 01) | 07, 08, 10, 09, 01 | B4 and B5, B6, B8, B7, B8 | the same two dispatches | with P2 | G3's B: the claiming pull request splits the entry. E6's B: B6 widens the record rule set to that expression, with the starter as its exhibit. G2's B: `media-downloaded-again` joins the register in B7; its C: B9 adds `withoutHeldMedia`, and outcome A is required before B13 merges. K3: P2's R, B and C1, and `/unseen` narrows a predicate in B7. Run 3: `seeds` is fixed in B8, with no register entry |
| G1, a form builder save of Nova's Save to Case shapes | 07 | B13 | its own CI, `saveToCase.retained.test.ts` over `hq-nova-then-builder` | no one | A: the test stays as control. B: `blockTreesEqual` gains one canonicalization, in B4. C: the forms become the variant `hq-nova-then-builder/save-to-case-saved`, recorded in `harness-findings.md` in B13 (section 8.1) |
| P3, the bundle's bytes; P5, proof 6 over the Nova-born corpus; P6, parity's first run; P8, the media read at the pin | 14 | B13 | its own CI | no one | P3's B or C: nondeterminism removed, or the product compared by what it answers. P5's B: a canon row in B7; its C or D: the reader is fixed in the claiming pull request; stack B does not merge with a `proof6` difference. P6's B or C: the reader, the Python reader or `elementWhere` is corrected. P8's B or C: part 05's media read is corrected in B1 |
| P4, the judge's cost | 14 | B13 | `ci.yml` with `proof_fresh=true`, by hand, then `node proof/run.mjs --timings` committed in B13 | the person | A: a median `proof6` item under five worker-seconds. B: the bundle's `--serve` mode |
| H3, H4, H5: the docs build, the plugin sweep, the contract sweep | 15 | B14, B12 | free reads and B14's own CI | no one | "Written and not yet run": as H2 to H4, for stack B |
| H7, stack B's exit | 15 | after the merge | section 11.2: `main`, the first night, the deploy | no one | "Written and not yet run": every row holds and step 6 is done; or the failing row is fixed forward, never by a register entry |
| H8, the census | 15 | after stack B is live | production, read-only, run by the person | the person | "Written and not yet run": a group alone keeps an app out, and step 7's order follows the count, a tie going to the first column and then to the listed order; or no reading holds a not-yet finding, or a no, and the listed order stands meanwhile |

Two runs the parts number send nothing themselves, so each
is named in its stack's billed check's row and has no row of its own: part 02's G5 is inside H1,
where part 02 expects `updateModule`, `setMenuMedia`, `createForm` and `updateForm` on the hash
run's list, and part 08's E7 is inside E1, where B6 changes no tool input and the hash run confirms
it (section 3, rule 7). Every other run of every part has one row above, and the top-level file's
table holds the same runs under the same ids and pull requests.

### 10.3 What must have answered before each merge

- **Before A1 merges**: P7 green, and one P1 run whose gate passes.
- **Before stack A merges**: Run 1 and Run 2 (A3); part 02's G1 and G4 at outcome A, each at
  first or after its correction landed (A4 does not merge with G4 unequal), its G3 and G6 each at
  an outcome written into A5 and A4, its G2 dispatch at outcome A or with its fix landed, and the
  A5 scan at "none found", at first or after each app it found was repaired; part 03's G1 run with
  the editors, G2 and G3, and G4's and G5's outcomes written into A8 and A6; part 04's R1, and both
  dispatches of R2; H1's passes recorded in A10; H2, H3 and H4; the three issues of section 3, rule
  12, filed, each before its pull request (A2, A3, A7) opened.
- **Before stack B opens for merge**: stack A's exit (H6), its first scheduled night green among
  it.
- **Before stack B merges**: part 05's G1 to G7, made before B1 opened; part 06's R1 and R2; part
  07's G2 and G4; part 08's E1 to E5; the B8 scan at its first outcome; part 11's R1 and R2; part
  09's K1, K2 and K4; part 12's M1, at outcome A or with the ceiling or the release its outcome B or
  C wrote into B10 and the run made again; E1's passes recorded in B12; both dispatches of P2, with
  part 07's G1 and G3, part 08's E6, part 09's K3, part 10's G2 and part 01's Run 3 each at an
  outcome that lets the stack merge (no base reading to an account, no unread register sentence, G2
  at outcome A or B); P4's timings committed; P3, P5, P6 and P8 green; H3 and H5.
- **After stack B's deploy is live**: the plugin's pull request merges; H7; then H8.

## 11. The exit

### 11.1 Stack A

Stack A is done when every row holds, each checked by a machine after the merge, from `main`, the
first scheduled night and the deploy's check-runs. None needs a person's judgment. In both tables a
bar inside a command is written `\|`, because it sits in a table cell: in the shell each is a bare
`|`. A check-run's `conclusion` is read through the REST call of section 3, rule 10, whose word for
a pass is `success`.

| # | What holds | The check |
|---|---|---|
| 1 | **The registers are as they were.** `proof/known-defects.json` is `[]`, `OPEN_DEFECTS` is `{}`, and no fixed entry left its control | `python3 -I -c "import json; assert json.load(open('proof/known-defects.json')) == []"` at `main`; `proof/checks/test_registers.py` in `main`'s lane; the register gate of the first night |
| 2 | **Proofs 1 to 5 pass on every Nova export and on the probe base's first publish.** Every corpus document, the twenty new ones among them, passes the bar, the intent and manifest checks and proofs 1 to 5, and `hq-plain`'s hop shows only the differences `proof/first-publish-changes.json` names | the lane on the merge commit (`gh run list --workflow ci.yml --branch main --limit 1`), and the first scheduled night with every reader (`gh run list --workflow proof-audit.yml --limit 1` green, or each group its issue names fixed and rerun alone) |
| 3 | **Every new concept is a complete feature.** Each of section 4's rows has its platform row, its cells and its offering sites held to the gate | `lib/commcare/surface/__tests__/platformFeatures.test.ts`, `lib/preview/__tests__/platformCells.test.ts`, `lib/doc/__tests__/platformOfferParity.test.ts`, and the Playwright specs `menu-above`, `register-from-list`, `number-keypad`, `prose-references`, `text-and-lists`, `names` and `preview-kept` in `main`'s CI |
| 4 | **The manifest states a standing for every entry, and no widen.** Every HELD-NEW and REFUSED entry names a subject, every HELD-NEW entry an owner, every TARGET-OWNED entry has its `KEPT_AT_HQ` row | `lib/commcare/surface/__tests__/manifest.test.ts`, `standing.test.ts`, `keptAtHq.test.ts`, `lib/publish/__tests__/hqFindingCopy.test.ts` in `main`'s CI; `rg -n '"direction": "widen"' lib/commcare/surface/entries` returns nothing |
| 5 | **The deploy is live, with its one migration applied.** | the merge commit's check-runs, listed first with `gh api repos/voidcraft-labs/commcare-nova/commits/<sha>/check-runs`, each with `conclusion` `success`: the migration Job applied `20261113000000_hq_round_trip_lookup_names` and the runtime probe refused no saved app |
| 6 | **The served contract is checked.** `MODEL_CONTEXT_VERSION` is `"v7-hq-round-trip-bring-in.a9"` (`.a10` under H1's outcome B), `RUNTIME_VERSION` 19, `scripts/test-schema.ts` holds `setFormSections`; the billed check passed for every tool it named; no scan script is left | `rg -n 'MODEL_CONTEXT_VERSION = "v7-hq-round-trip-bring-in\.a(9\|10)"' lib/models.ts`; `rg -n 'RUNTIME_VERSION = 19' lib/db/appTests.ts`; `rg -c 'name: "setFormSections"' scripts/test-schema.ts` prints 1; A10's description records H1's passes; `lib/mcp/__tests__/servedSchemas.test.ts` in `main`'s CI; `git ls-files scripts \| rg 'case-list-registration-registrations'` returns nothing |
| 7 | **The contracts and the docs say what is so.** | H2's two commands, run at `main`, print nothing; the docs build of `main`'s CI |

### 11.2 Stack B

Step 6 is done when every row of 11.1 still holds and every row below holds, each checked by a
machine after stack B's merge, from `main`, the first scheduled night and the deploy's check-runs.
Row 3 is the outline's exit condition as it now stands (part 14, Departure 7).

| # | What holds | The check |
|---|---|---|
| 1 | **The registers are as they were**, and no entry of either names `proof6`, `parity`, `source` or `changes` | row 1 of 11.1; `proof/checks/test_registers.py` holds the loader's refusal of such an entry |
| 2 | **Proofs 1 to 6 pass on every corpus document, with every reader.** Reading Nova's own export of each Nova-born document gives its canonical form, and parity holds between the reader's claim log and the lane's standings wherever Python decides | the lane on the merge commit and the first scheduled night, as row 2 of 11.1; `proof/checks/test_proof6_fixed_point.py`, `test_parity.py` in the lane |
| 3 | **Every base comes in, republishes and passes its proofs; every variant is refused or held as its `expected.json` says; every manifest entry is base-exhibited, variant-exhibited or exempt with a reason.** | the twenty-two bases' groups green in the lane and the night (their A-to-B hop under proofs 1 to 5, proof 6 and the `source` comparison); `lib/commcare/reader/__tests__/hqApps.test.ts`, `hqAppVariants.test.ts`, `schemaKeyVariants.test.ts`, `twoRefusals.test.ts`, `fixedPoint.retained.test.ts` and `lib/commcare/surface/__tests__/entryCoverage.test.ts` in `main`'s CI; `proof/matrix/test_classified.py` in the lane |
| 4 | **A reading is accepted only when its five checks hold, and creates nothing otherwise.** | `lib/deployment/reading/__tests__/acceptance.accepts.test.ts`, `acceptance.doctored.test.ts`, `birth.postgres.test.ts`, `createDigest.postgres.test.ts`, `birthClaimRace.postgres.test.ts` in `main`'s CI |
| 5 | **The first-publish register is closed both ways.** On every base the predicted ids equal the observed ones, and every rewrite that changes behavior is declared by a register entry or refused by a manifest entry | `proof/checks/test_first_publish_changes.py` in the lane; `proof/ci/__tests__/firstPublishChanges.test.ts`, `lib/commcare/__tests__/emissionRewrites.test.ts`, `lib/deployment/reading/__tests__/firstPublishChanges.test.ts` in `main`'s CI. The count is read from the registry and pinned nowhere |
| 6 | **The deploy is live, with its three migrations applied.** The guard found no HQ app two live Nova apps publish to | the merge commit's check-runs, listed first as in 11.1, each with `conclusion` `success`; B8's description records the scan's first outcome (section 5.3) |
| 7 | **The readings' routes are reachable where they should be and nowhere else.** | `app/api/commcare/readings/__tests__/routes.test.ts`, `app/api/commcare/hq-apps/__tests__/route.test.ts` and `app/api/commcare/connection/__tests__/route.postgres.test.ts` in `main`'s CI; `e2e/tests/app/bring-in.spec.ts` and `e2e/tests/browser/bring-in.spec.ts` in the smoke |
| 8 | **The served contract is checked.** `MODEL_CONTEXT_VERSION` is `"v7-hq-round-trip-bring-in.b12"`, `RUNTIME_VERSION` 19, `scripts/test-schema.ts` holds `getOrganization`; part 13's E1 passed for every entry the hash run named; every served schema compiles and the six new tools declare their scopes | `rg -n 'MODEL_CONTEXT_VERSION = "v7-hq-round-trip-bring-in\.b12"' lib/models.ts`; `rg -c 'name: "getOrganization"' scripts/test-schema.ts` prints 1; B12's description records E1's passes; `lib/mcp/__tests__/servedSchemas.test.ts`, `bringInToolScopes.test.ts`, `lib/commcare/__tests__/projectSpaceCompatibilityBoundary.test.ts` in `main`'s CI |
| 9 | **The plan has left and what it deferred is written.** `docs/plans/hq-round-trip/` holds `README.md` and `7-rest-of-model.md`; the README reads step 6 done; no file outside the research names the plan or the outline's file; the one-off scan is gone and the inspector stays; the plugin's pull request is merged | `git ls-files docs/plans/hq-round-trip`; `git grep -l -E '6-bring-in\|6-import' -- . ':!docs/research'` returns nothing; `git ls-files scripts \| rg 'scan-hq-app-claims'` returns nothing; `git ls-files scripts/inspect-hq-readings.ts` prints the path; `gh pr view <plugin pull request> --repo voidcraft-labs/nova-plugin --json state` reads `MERGED` |
| 10 | **The contracts and the docs say what is so.** | H5's first three commands, run at `main`, print nothing, and its fourth prints the four lines H5 names, each about records, a CSV or the CommCare HQ app file; the docs build of `main`'s CI |

## 12. The whole plan's departures, and the outline's ten items

Each part argues its own departures under "Departures": from the outline, from the research, and
the decisions where an alternative was weighed and not taken. This section collects them by kind,
one row each, so the plan's top-level file can state them once. "Part 07, 4" is part 07's
Departure 4.

### 12.1 Alternatives weighed and not taken, and departures from the outline and the research

**Alternatives weighed and not taken.** Each row names a design an implementer could reach for and
what the plan does in its place. The Departure named states the alternative with the evidence that
decides against it.

| Not done | The plan does | Where argued |
|---|---|---|
| subjects and standings under `lib/commcare/surface` and `lib/commcare/reader` | the vocabulary and its copy live in `lib/publish/hqFindings.ts` and `hqFindingCopy.ts` | part 01, 6 |
| `persistent_menu`, `show_breadcrumbs` and Android logo slots are not-yet | each is kept: Preview draws neither menu setting, and the `.ccz` states that it cannot carry a logo | part 01, 1, 2 |
| a media file or a table over Nova's limits is a circumstance | each is a manifest entry; a circumstance with a standing never names what an entry names | part 01, 3 |
| `unrecognized` is to change in CommCare HQ | it is not-yet, Nova's to classify; and a class a part can name gets an entry of its own | part 01, 4; part 07, 14 |
| a closed list of about eighteen circumstances | thirty-five, landing 20, 27, 28, 34, 35 across A2, B1, B2, B9, B10; a `fix-in-hq` finding also carries its cause | part 01, 11, 12; part 05, 4; part 06, 10; part 11, 11; part 12, 6 |
| the fifteen settings are seeded where the target holds none | on a brought-in app's deployment a publish seeds none of them | part 01, 13 |
| the `always` arm names any registration form of the type in any menu | narrowed to the shapes HQ's build admits and Nova can return from; the wider shapes are not-yet under `menus` | part 02, 1 |
| `put_in_root` as six generated effects, each as lenient as HQ's build | it has eleven, each a rule of validation, emission or Preview; and Nova is stricter than HQ's build on a display condition that reads the case, on the previous screen, and on frames through the first menu | part 02, 2, 3, 7, 8 |
| plain text on hints, help and validation messages is held | only a help text's is stored; Nova writes no formatted copy for a hint or a validation message, in any app | part 03, 1, 2 |
| the forty-five widen rows decided in part 03, beside its questions and text | decided row by row in part 04: nine built, eighteen split, eighteen answered by A2, A3 and A5; four name classes are not-yet; quotes are in but for both kinds in one value; five reserved case type names leave; `category` and `state` are built | part 03, 5; part 04, 1, 2, 3, 6, 7 |
| every finding in one pass | three things stand outside one pass, and the account says a later check may find more | part 06, 11 |
| several `_xpath_query` rows are held as one conjunction | each top-level conjunct is held where Nova has a slot; two shapes are not-yet where the menu's forms do not read the search | part 07, 2 |
| the UUIDv5 is over the app's UUID as its namespace | the app's id is in the name, under one fixed namespace | part 10, 4 |
| moving an app to recently deleted releases its claim | `released_at` is written when another app takes the HQ app; `softDeleteApp` is unchanged | part 10, 1 |
| every CommCare HQ media path is kept | three kinds of path are not kept; the file takes Nova's path, as a declared first-publish change | part 10, 6 |
| table, column and row ids are minted at the reading | table and column ids are; row ids stay the lookup writer's | part 12, 2 |
| API access is checked once, first | it is checked twice: when the project space is chosen, and at the application resource | part 05, 5 |
| the reader returns a batch, identities and findings | it returns the document beside its batch, the declaration choices, facts, a census and the claim log, and findings only where there is no draft; a claim's place is two fields | part 06, 4, 5 |
| anything unclaimed is a finding | two uses are handed off, for project data's rules to settle | part 06, 13 |
| structure, case management, menus, then expressions | a menu's own shape is read before case management, and a link's condition is registered last | part 06, 14; part 07, 12 |
| one fold-back pass, and a record binder | folds run inside the binder; no second binder for record slots; the CSQL binder is new | part 08, 4, 5 |
| HQ's entry datums equal Nova's ids | the facts HQ's entry builder reads are compared, and an unknown id is a finding | part 07, 6; part 08, 7 |
| only failures of checks 3 to 5 are `read-back-differs` | so are a failure of check 2, a reader defect beside a clean read, and the other failures of check 1 | part 09, 1 |
| D and each split document are re-read | one re-read a call | part 09, 3 |
| check 3 reads an absent key as HQ's schema default | three keys are handed to the re-read at the source's own values, `build_spec`, `multimedia_map` and `logo_refs`: Nova's body never carries them, CommCare HQ keeps each through an update, and at their defaults no app would pass | part 09, 15 |
| a real attribute and its `vellum:` shadow that disagree are a finding of the expression reader | the check is the forms reader's, in B3; B6 plans no second one | part 08, 11 |
| every other HQ spelling of what Nova holds is read | `#parent` is read; `#host` is not-yet, since HQ's text names no case type for the step and Nova holds the relation only with one | part 08, 12 |
| a changed version restarts the read | the read answers `changed`, and the next step runs one more attempt | part 05, 2 |
| the `target_*` columns come from the reading | one such column exists, and it is null at birth | part 10, 2 |
| media is fetched into the existing pending state and kept seven days | bytes are staged with no asset row and kept one day, the bucket's own rule; the verdict is kept for the reading's life | part 11, 1, 15 |
| tables before the genesis tail, places after | both are written inside it, through the seam `afterAppInsert` | part 12, 1 |
| three steps; the row stores the account or the review | the first step runs acceptance too; the row stores a stop, an account or a review; Remove keeps the row with its content-free census; the reader and acceptance run in a worker thread, under a heap limit of its own | part 12, 3, 4, 5, 16 |
| the picker reuses the Publish dialog's connection aside and its `router.refresh()` as they stand, with no route of its own for checking the connection | two routes more than the readings' own six, both B11's and both under the prefix the allowlist already holds, so bringing an app in still adds no route the proxy allowlist does not hold (part 12, section 4.1): `GET /api/commcare/hq-apps`, which the picker lists a project space's apps through, and `GET /api/commcare/connection`, so that "Check connection" in the picker and in the Publish dialog no longer goes through the Next router | part 13, 3 |
| three MCP tools; `bring_in_hq_app` takes `project_id` | six tools; `read_hq_app` takes the Project | part 10, 3; part 13, 1, 2 |
| one first-publish list on the review `read_hq_app` returns, beside its digest | the first-publish list is on each `runs_on` entry of the review and not once on the review, because three of its entries change with the choice | part 13, 14 |
| an agent that always asks which Project, even where the person can edit only one | where a person can edit exactly one Project it is stated and not asked; with two or more the agent asks and never picks | part 13, 15 |
| "since Nova brought it in on <date>", with no word on whose day | the upload route's body gains the optional `viewer`, the reader's time zone, for that one date; MCP's sentences name the UTC day | part 10, 7 |
| a refresh on the Publishing card that always re-reads and rewrites the baseline | the refresh rewrites the baseline only where nothing Nova writes has changed in CommCare HQ | part 01, 5 |
| a ladder of named steps with results; a way to stop reading; "Bring it in" disabled until every choice is answered | the running step's name alone; a step cannot be stopped; "Bring it in" is never disabled for a missing answer | part 13, 4, 5, 6 |
| every creation lands through the one receipt, in place | an app brought in to a Project the tab is not scoped to lands by a full load of `/build/{id}` | part 12, 15 |
| "Stop publishing here" only on a brought-in app's card; a header chip and a check on open | on every card with a live app mapping; no header chip and no check on open | part 13, 10, 12 |
| ownership is derived under the Project state lock | no lock is held from the plan to the workbook; the window is stated | part 11, 2 |
| places are never pushed to any project space | never to the project space that manages them; another project space gets them from the copy | part 11, 3 |
| a reference with no file is inert where source shows no runtime reads it | decided by slot, kind and platform | part 11, 10 |
| levels from what the app reads; worker properties typed from use | every level HQ lists comes in once the app reads places; nothing is typed | part 11, 12, 16 |
| the HQ app file's guide alone names each managed table | the guide names each, and a second workbook carries them | part 11, 8 |
| the rewrite registry is B7's; the required stamp, date-and-time formatting and markdown forms are entries | B6 creates the registry with eight entries; the stamp changes no behavior, date-and-time formatting is refused, and markdown forms need none, being spelling a proven lane rule erases | part 08, 6; part 09, 4; part 03, 8 |
| each register entry's predicate over A alone | over the reading: the source, the document, the facts and the choice | part 09, 5 |
| the reader refuses or declares any reordering of a setvalue that reads another node | neither: a preload whose place in the load Nova cannot hold is not-yet, for a basic and an advanced preload alike, and the manifest's REFUSED row for a basic preload is re-cut to HELD-NEW with owner `forms-and-case-management` | part 07, 9 |
| reading exactly, or refusing, a column only the detail shows and a link that carries a case by hand | each is read as Nova's concept and declared as a worker-touching change | part 07, 7, 13 |
| the probe base is a starter app; the bundle's digest keys proof 6 alone | the probe base is `hq-plain`, since no starter can be written before A4 and A5; the digest joins every corpus document group's key | part 14, 1, 2 |
| bar, intent and manifest run over B alone; coverage is total | they judge A too; sensitivity is not run on a base; coverage is three sets and an exemption list, with `schema:`-only entries shown by a sample table | part 14, 3, 4, 5, 7 |
| part 14 collects the canonicalizations | part 09 holds the one registry, and part 14 runs it | part 09, 9; part 14, 13 |
| `MODEL_CONTEXT_VERSION` moves once, in A10 | it moves in A4 to A9, in B6, B9 and B12; A10 moves it only on a forced correction | part 02, 4; part 03, 9; part 04, 8; part 08, 10 |
| `RUNTIME_VERSION` stays 18 | 19 from A9: Preview's query wrapper is renamed | part 04, 10 |
| stack B in id order, B7 beneath B8 | B1 to B6, B8, B9, B7, B10 and on | part 09, 14 |
| no existing app's next publish changes | from A8 every app's next publish drops a hint's and a validation message's formatted copy, which nothing reads | part 03, 2 |
| one production scan before a merge, the duplicate-claim scan | A5 carries one more read-only scan | part 02, 6 |

**From the outline.**

| Item | The outline said | The plan does | Where argued |
|---|---|---|---|
| 1 | refuse an app with a translation for a runtime UI-catalog key | it comes in; the keys are kept | part 01, 7 |
| 1 | a stored `xmlns` slot | not built; `xmlns` is a ledger row on the project space the app came from | part 10, 5 |
| 2 | `hq-import`, the third owner | `hq-adoption`, the fourth caller of the genesis writer; identity rows are dense; the privilege is insert and delete | part 10, 5; part 12, "Executed during planning" |
| 3, the cutover | a `referenced` record, and one cutover merging lookup records | no `referenced` value, no Project-level table, no data move: ownership is derived | part 11, 5 |
| 4 | drift merging in step 6 | step 7's first group, `changes-made-in-hq`; step 6 keeps the stop and adds "Stop publishing here" | part 01, 9; part 10, 5; part 14, 8 |
| 6 | every widen built | nine built, eighteen split with owners, eighteen answered elsewhere, and the manifest stops being able to state a widen | part 01, 8; part 04, 5 |
| 7, Exit | one HQ app an entry, plus generated combinations | bases, variants and exemptions; the one composed variant `two-refusals-one-pass` | part 14, 7 |
| 8 | `unwrap-list` into `value-list`, device-data reads into their arms, `call` admitted in record slots | `list(...)` is read and kept, never authored anew; device-data search values and `call` in a record slot are not-yet; `cond` reads as nested `if` | part 08, 1, 2 |
| 8 | decide the project's day | a date-only comparison on a system date stays not-yet; HQ's own `today()` reads as Nova's, declared at the first publish | part 08, 3 |
| 8 | an imported label's `instance(…)` text is a shape only an imported app holds | any author can type it today; Nova's own emitter changes for every app | part 03, 3, 4 |
| 9 | refuse with `unavailable-on-declared-platform`; admit `xsd:dateTime` on a bind-only node | the circumstance `no-platform-runs-everything`, one finding a use; the bind rule is widened to every bind type | part 06, 2, 3 |
| 9, 10 | bringing an app in asks the confirmations a publish asks | it asks none; the plan features the app already uses are recorded, and the rest stays the first publish's | part 07, 11; part 10, section 6.5 |
| 10 | Save to Case blocks matched to placements | held only in Nova's own shape, by four tests and one entry | part 07, 4 |
| 10 | an advanced form's selections tested against a stored chain | the chain is built from the loads | part 07, 5 |
| 10 | an advanced load's preload stays HELD-NEW | it reads as a default under the rule of a basic preload, so the entry splits and its same-state class becomes HELD in B4 | part 07, 8 |
| 10 | model iteration by the load-time rule | not built; held where Nova's rule runs it, not-yet otherwise | part 06, 1 |
| 10 | refuse `auto_launch: false` where Web Apps is declared | decided by the HQ app's own `cloudcare_enabled` | part 07, 10 |
| 10 | the registration from the case list reads into one arm | the reader chooses between two arms by the manifest's rule | part 02, 5 |
| 10 | ending decides which deployments count as published for placements | nothing reads a deployment to judge a placement, so there is nothing to decide | part 10, 5 |

**From the research.**

| The research said | The plan does | Where argued |
|---|---|---|
| a lookup table's rows are read through `LookupTableItemResource` | through `FixtureResource`, the resource Nova already calls | part 05, 1 |
| lookup and case property grammars widen | over ASCII only; a period is left out; the rest is not-yet | part 04, 4 |
| a `types` tag is referenceable and the caps grow | both stay not-yet, under `project-data-at-hq-size` | part 11, 6 |
| a table an app only reads is recorded as `referenced` in its source project space | it is a copy managed in CommCare HQ, a fact of the Project's table; the ledger gains no ownership value | part 11, 5 |
| seven steps, each with one cutover | step 6 is two stacks, two ordinary deploys and no cutover | the top-level file, "What changed from the outline, and why", items 11 and 25; section 5.4 here |

### 12.2 What became of the outline's ten items

| Item | Settled by | How |
|---|---|---|
| 1, the reader | parts 05 to 09 (B1 to B7), part 10 (B8) for identity | one pure reader over inputs read beforehand, admission as an accounting over the manifest, and acceptance by five checks; no stored `xmlns` |
| 2, the birth owner | part 12 (B10), part 10 (B8), part 11 (B9) | `hq-adoption`; tables, places, media edges, the adopted deployment and the claim commit with sequence 1, and media bytes are published before it |
| 3, project-space data | part 11 (B9) | copies managed in CommCare HQ, refreshed before a publish, with ownership derived |
| 4, drift merging | step 7, `changes-made-in-hq` | step 6 states the stop by origin and adds "Stop publishing here" (part 10, B8; part 13, B11) |
| 5, entry points | part 13 (B11, B12), part 12 (B10) | three entries in the builder and six MCP tools; the declaration is a preselected choice in the review |
| 6, grammar widenings | part 04 (A9), part 01 (A2, A3), part 02 (A5) | all forty-five rows answered |
| 7, feature-matrix apps | part 14 (A1, B13) | twenty-two bases, the variants, the sample table and the exemptions |
| 8, what step 3 left | part 08 (B6), part 07 (B5), part 03 (A7) | expressions read by one recognition method; `_xpath_query` rows by conjunct; a calculated value in text as a stack A concept |
| 9, what step 4 left | part 06 (B2, B3), part 08 (B6), part 11 (B9), part 13 (B11), part 12 (B10) | the declaration proposed and chosen in the review; media judged by platform; the split read back as ordinary questions; the guarded and `current()` reads read back by part 08's recognition method (B6; its sections 5.3 and 5.5, and run E4) |
| 10, what step 5 left | part 07 (B4, B5), part 06 (B3), part 03 (A8), part 02 (A4, A5), part 10 (B8) | placements held at CommCare HQ's real position, links read in reverse, the search workflow from three booleans, text shown as typed |
| "Cutover and migration" | part 11 (B9); section 5 here | none |
| "Contracts" | section 6.1 here | five rows, each placed |
| "Exit" | part 14, Departure 7; section 11.2 here | row 3 |

### 12.3 Decisions that reach across two parts

Each row is a decision that reaches across two parts, or a part and a file this plan changes,
where each side alone gave a different answer. Each is decided by these principles (one home for a
list; a file lands where its code is first true; a hand-off not taken is refused with its reason)
and written into this part. "The two sides" is what each place held before the decision. Every part
named says what was decided, so no two files of the plan differ on any row, and the table stays to
say what was decided and why.

| Where | The two sides | Decided |
|---|---|---|
| part 07, "What this part needs of other parts", against part 09, section 11.2, row 16 | part 07 asked that `list-settings-respelled` hold `/modules/*/search_config/title_label` and `/modules/*/search_config/description`, for the blank text map its section 12.4 reads; part 09's row held two case detail paths | B7's row 16 holds all four paths, and part 09's row now does. Part 07 is the part that knows what its reader writes, and a path the register lacks would fail the lane's judge as an unnamed difference (part 09's K3, outcome B). The row's sentence stands |
| part 05, "Contracts", against this plan's own pull request | part 05 had B1 add the heading "Found while planning step 6" to `harness-findings.md` with ten sentences; the plan's own pull request writes that heading from every part | the heading and part 05's ten facts land in the plan's own pull request; B1 adds no heading and completes only its own runs' outcomes under it, by the one rule of section 8.1, which part 05's "The harness findings" and its G1, G2 and G4 rows now state |
| part 02, run G5, against part 02, section 12 | G5 named `updateModule` and `setMenuMedia`; section 12 adds a sentence to `CASE_LIST_REGISTRATION_DESCRIPTION`, which `createForm` and `updateForm` serve | H1's list is the hash run's, and part 02's G5 now expects all four on it |
| part 06, "Contracts", against its own B2 row | it said the root's mental model 3 stands, while B2 takes "One-way emission boundary" out of `lib/commcare/CLAUDE.md` | B14 rewrites the clause (section 6.2), and part 06's "Contracts" now carries the sentence and no longer says the item stands |
| part 03, section 9, against `scripts/test-schema.ts`'s entry shape | A7 registers `setFormSections`; an entry needs a prompt, and part 03 gave none | section 13.3 gives it, part 03's section 9 now carries the same entry in full, and A7 lands it |
| part 03, section 9.2, against part 04, "Executed during planning" | part 03 mapped a text's path to its prose slot for `createForm` and `createModule` among others; part 04 finds that neither tool holds a field or an option schema, which `rg` at `main` confirms | `proseSlotAt` holds an arm only for a tool that holds a wording position (`addFields`, `editField`, `setFormSections`, `setFieldOptionsSource`, `updateTranslations`), and H1's list does not expect `createModule`. Part 03's sections 9 and 9.2 now say so |
| part 13, run E1, against section 1.3 here | E1 named `getLookupTables` and `getOrganization` and said no other entry is sent; every pull request of stack B records the tools whose hash moved, so a move E1 does not name would be recorded and never checked | E1's list is the hash run's between the `main` stack B was cut from and B12's head, with those two expected (section 3, rule 7). Part 13's E1 and its section 15.3 now say so, and its question, outcomes and files stand, with the count and the names the run gives |
| part 06, section 2.4, against section 6.2 here | part 06 left the Biome rule's message as it was, "lib/commcare is the one-way CommCare emission boundary", and its "Contracts" rewrote one "one-way" sentence of `lib/commcare/CLAUDE.md`; this part rewrites the root's same clause as false once the reader exists | every place that says it is rewritten (section 6.5): two more sentences of `lib/commcare/CLAUDE.md` and two source comments in B2, and the message's first sentence in B7, which already edits those four strings. B2 still changes no line of `biome.json`. Part 06 (section 2.4, "Contracts", "Files by pull request") and part 09 ("Contracts", "Files by pull request") now carry these edits in the same sentences |
| part 14, "Contracts", against the root `CLAUDE.md`'s `proof/` bullet | part 14 replaced a quoted fragment that ends at "known-defect register"; the file's sentence goes on with a clause about that register, which the replacement alone would hang on the first-publish register | section 6.2 writes the sentence whole: part 14's words in part 14's order, with the clause kept after the register it describes. Part 14's row now holds the whole sentence |
| part 07, "Claims corrected", against part 14, "Executed during planning" | part 07 said CommCare HQ's basic Case Management page has a load section and re-cut `forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held` from REFUSED to HELD-NEW partly on that; part 14 said the page draws none | the page draws none, read at the pin: the basic page's transaction template draws no load, and the load template is drawn by the advanced page alone. The re-cut stands on its other ground: HQ's save keeps a stored basic preload and HQ's build writes it, so the shortfall is Nova's. Owner `forms-and-case-management`; part 07, part 14, `7-rest-of-model.md` and section 8.3 here now say the same |
| part 03, runs G1 and G3, against part 08, section 9.2 | part 03 had B3 claim the two entries that exist only under a run's outcome, at the `<output>`; the class is a property of the bound value, which only binding knows, and part 06 claims neither | B6 claims each, in part 08's prose slot row, ahead of `questions/output-value-any-other-expression`, by the predicate A7 exports for the rule (`proseValueNotKeptByFormBuilder`, `proseValueBreaksValidationMessage`). Parts 03, 06 and 08 now say so |
| part 03, section 2.4, against part 01, Appendix A.1 | part 03 gave the acknowledge question, face capture and the Android app callout to step 7's `question-display`; Appendix A.1 gives the three entries the owner `xform` | Appendix A.1 stands. `xform` owns the three kinds, and `question-display` needs the callout kind from it for one reference; part 03 and `7-rest-of-model.md` now state that as ownership |
| part 02, section 16, against this plan's decision that step 6 runs no Job (decision 4; section 5.4) | on the A5 scan's "Some found" outcome part 02 had a migrate script change a production app, with no writer, identity or `app_changes` kind named; decision 4 named no Job for any outcome | section 5.3: a reviewed plan, one `blueprint-migration` row an app by `system:case-list-registration-registrations`, run once locally and once through the fenced Job runner before stack A merges, and every file of it removed in the last commit of A5's pull request. On the expected outcome there is no Job. Part 02's section 16 and its A5 file list now carry the same steps and files |

## 13. A10 in full: the agent

A10 is the pull request at which stack A's model-facing surface is read whole and checked with the
provider once. Its own diff is small on purpose: every sentence and every input landed with the
behavior that makes it true, and each of A4 to A9 moved the version literal for it.

### 13.1 What the guide holds at A10's head

`lib/agent/authoring/reference.ts::AUTHORING_REFERENCE` is what the Solutions Architect and an MCP
agent read. Stack A's additions, each written by the part that makes it true:

| Where in the guide | Text | PR | Owner |
|---|---|---|---|
| the menus section | the paragraph that begins "A menu can show its forms in the menu above (forms_in_menu_above on update_module):" | A4 | part 02, section 12 |
| the menus section | the paragraph that begins "A case list can offer a registration form from another menu at any time (register_from_case_list on update_module)," | A5 | part 02, section 12 |
| the generated platform sentences | the row `case-list-registration-media`'s sentence | A5 | part 02, section 13 |
| the fields reference | `${platformSentence("number-keypad")}` | A6 | part 03, section 9.1 |
| the forms paragraph, after "Worker values use {{#user/property}}." | "{{= formula}} shows a calculated value, checked like calculate: {{= format-date(date(#form/dob), '%e %b %Y')}} shows a date the way you format it." | A7 | part 03, "Copy" |
| the forms paragraph, its first two sentences | "Form wording is Markdown. A label or a choice with plain_label, a help text with plain_help, and every text of a form with plain_text are written without formatting: a label then shows exactly as typed, and a choice or a help text does on Android." | A8 | part 03, "Copy" |
| the `expressions` entry, after "Read the form’s recordContext for the available types." (the file's apostrophe is the typographic one) | "A record type named form, user, search, case, record or row is written #record/<record-type>/<property>, as in #record/case/region; that spelling reads any type." | A9 | part 04, section 13 |

A10 reads the guide whole at its head and holds three things, each by an existing test or by
reading: the forms paragraph opens with A8's two sentences and still holds A7's sentence after the
worker values sentence (A7 and A8 both edit that paragraph); the generated platform sentences sit
where `lib/agent/authoring/__tests__/platformGuide.test.ts` pins them; and no sentence names an
input a served schema lacks (`lib/agent/authoring/__tests__/guideExamples.test.ts`). Where one of
the three fails, the sentence is corrected as a fix-up in the pull request that wrote it, by rule 4
of section 3: A8 for the forms paragraph's order, since A8 is the later of the two that edit it,
and for the other two the pull request whose platform row or input the failing test names. That
pull request's own literal already covers the change, and the two tests fail at its own head, so
its CI finds it before A10 does. A10 changes the guide only under H1's outcome B. No test is added
for a guide sentence: copy is not pinned (`lib/agent/CLAUDE.md`, `docs/testing.md`).

### 13.2 The version the stack deploys

`"v7-hq-round-trip-bring-in.a9"`, which A9 wrote, unless A10 changed a served tool's name,
description or input schema, or the guide, which happens only under H1's outcome B. Then it is
`"v7-hq-round-trip-bring-in.a10"`. `RUNTIME_VERSION` is 19 either way.

### 13.3 `scripts/test-schema.ts`

Stack A registers one tool, `setFormSections`, in A7, the first pull request to change its served
schema (its section `label` takes the new `text` description). Part 03's section 9 holds the entry
in full, and it is:

```ts
{
	name: "setFormSections",
	description: setFormSectionsTool.description,
	schema: setFormSectionsTool.inputSchema,
	prompt:
		'Use setFormSections with moduleUuid 11111111-1111-4111-8111-111111111111 and formUuid 22222222-2222-4222-8222-222222222222 to put field 33333333-3333-4333-8333-333333333333 on a page titled "About the household" and field 44444444-4444-4444-8444-444444444444 on an untitled page.',
},
```

after the `updateForm` entry, with its import from `lib/agent/tools/setFormSections.ts` and its name
in the header's list of known names.

A10's own diff is the prompts of six registered entries, so that the one request each sends asks
for a call that uses an input stack A added. A provider accepts or refuses a schema whatever the
prompt says, so every other entry keeps its prompt:

| Entry | The prompt at A10's head |
|---|---|
| `updateModule` | `Use updateModule with moduleUuid 11111111-1111-4111-8111-111111111111 to rename it to "Patients", give it its own screen (forms_in_menu_above null), and offer the registration form 22222222-2222-4222-8222-222222222222 on its case list with the button text "Register a new patient", going on with the new case after registering.` |
| `setMenuMedia` | `Use setMenuMedia with three items in one call: set moduleUuid 11111111-1111-4111-8111-111111111111 icon to the built-in household icon, formUuid 22222222-2222-4222-8222-222222222222 under that moduleUuid to the built-in register icon, and the Register button on that module's case list (target case-list-registration) to the built-in register icon. Clear every audio label (null).` |
| `addFields` | today's prompt, then: `Also add a text field phone with keypad numbers, and a text field notes whose help text "Use *short* words" shows exactly as typed (plain_help true) and whose label is "Visit on {{= format-date(date(#form/visit_date), '%e %b %Y')}}".` |
| `editField` | today's prompt, then: `Also set keypad to numbers and plain_help to true.` |
| `setCaseSearchDisplay` | `Use setCaseSearchDisplay with moduleUuid 11111111-1111-4111-8111-111111111111 to show no search title ({ "kind": "none" }) and clear every other display slot (null).` |
| `createForm` | today's prompt, then: `Turn text formatting off for the whole form (plain_text true).` |

Under part 03's G4 outcome B, `plain_help` leaves the two prompts that name it.

### 13.4 The one billed check: which tools, the command, the question

**Which tools.** The implementer runs `npx tsx --conditions=react-server
scripts/inspect-tool-schema-hashes.ts` at the `main` stack A was cut from and at A10's head (free,
no network). The list is every Solutions Architect tool whose hash differs. What the parts expect,
with the pull request that moves each:

| Tool | Moved in |
|---|---|
| `updateModule` | A4, A5 |
| `setMenuMedia` | A5 |
| `createForm`, `updateForm` | A5 (`CASE_LIST_REGISTRATION_DESCRIPTION`), A8 (`plain_text`); `updateForm` again in A9 (`CONNECT_ID_FIELD_DESCRIPTION`) |
| `addFields`, `editField` | A6 (`keypad`), A7 (`text`), A8 (`plain_help`), A9 (the option value's and the case type's patterns) |
| `setFormSections`, `updateTranslations` | A7 (`text`, `localized`) |
| `setFieldOptionsSource` | A7 (`text`), A9 (the patterns, `minItems`, its `source` description) |
| `setCaseSearchDisplay` | A8 (the `none` arm) |
| `addCaseListColumns`, `updateCaseListColumn` | A8 (`blanks`) |
| `configureCaseList` | A8 (`blanks`), A9 (the Search field name's pattern) |
| `generateSchema`, `updateCaseProperty` | A7 (a case property's label, hint and choice labels are `text` positions), A9 (the option value's pattern) |
| `addCaseOperations`, `updateCaseOperation` | A9 (the case type's and the written property's patterns) |
| `addSearchInputs`, `updateSearchInput` | A9 (the Search field name's pattern) |
| `createLookupTable`, `updateLookupTable`, `editLookupColumns` | A9 (the tag's and the wire name's patterns) |
| `configureConnect` | A9 (`CONNECT_ID_FIELD_DESCRIPTION`) |

Twenty-three names. A7's `text` description reaches the tools that hold a wording position, which
at `main` are the ones `lib/agent/toolSchemaGenerator.ts`, `lib/agent/planningSchemas.ts` and
`lib/agent/tools/setFormSections.ts` build; `createForm` and `createModule` hold none (section
12.3). The hash run is the record and this table is what it is held to: a tool the run
names that the table misses joins the list, and the count in the question, named as the difference;
a tool the table names whose hash did not move leaves the list; and a moved tool the script does
not register was missed by the pull request that moved it, so A10 registers it, with a prompt that
uses one of its inputs, and names it in its description.

**The command.** `npm run test:schema -- <name>`, once for each name on the list, in the
implementer's shell, on the person's key. Never the bare `npm run test:schema`, which would send
every registered entry.

**The question**, asked once, with the hash run's count and names in place of these:

> Stack A adds or changes 23 of the tool definitions the Solutions Architect is given, and
> `npm run test:schema` checks that OpenAI accepts each one. Running it for these 23 sends 23 live
> OpenAI requests on your key, one per schema: `updateModule`, `setMenuMedia`, `createForm`,
> `updateForm`, `addFields`, `editField`, `setFormSections`, `updateTranslations`,
> `setFieldOptionsSource`, `setCaseSearchDisplay`, `addCaseListColumns`, `updateCaseListColumn`,
> `configureCaseList`, `generateSchema`, `updateCaseProperty`, `addCaseOperations`,
> `updateCaseOperation`, `addSearchInputs`, `updateSearchInput`, `createLookupTable`,
> `updateLookupTable`, `editLookupColumns` and `configureConnect`. May I run it?

**What a failure lands.** H1's outcome B: the refused schema or description is corrected in A10, in
the tool's own file; `lib/models.ts` moves to `.a10`; the guide sentence that teaches the corrected
input is corrected with it; `lib/mcp/__tests__/servedSchemas.test.ts` takes the new served bytes
where it snapshots them; and that one entry is asked about again. A correction that would change
what a feature does, and not how its input is spelled, goes back to the feature's own pull request
as a fix-up and is reviewed there.

### 13.5 A10's tests and checks

No product code, so its tests are the ones that hold what it reads: `servedSchemas.test.ts`,
`platformGuide.test.ts`, `guideExamples.test.ts` and the hash run. The plugin sweep H4 runs at its
head.

## 14. A11 in full: contracts and public docs for stack A

A11 lands, in one pull request: the texts of section 6.3 in `docs/architecture/complex-apps.md`
(part 04's three, this part's wording for parts 02 and 03), and the rows of section 7.1 marked A11
across ten public pages. It changes no `CLAUDE.md`: each subtree row landed with its behavior
(section 6.5), and A3 landed its own pages and its `contracts.md` paragraph.

Its order of work: the outcomes of part 03's G4 and G5, of part 02's G3 and G6, and of part 04's R2
are read from A8's, A6's, A5's, A4's and A9's descriptions, and each sentence that depends on one
takes that outcome's wording ("Written and not yet run", the last table); the texts are written; H2
and H3 run; and its description records H1's passes by reference to A10, H4's result with the
plugin's sha, and the hash run's statement that no tool moved in A11.

Its tests: the production build, which builds the docs through fumadocs;
`lib/commcare/__tests__/projectSpaceCompatibilityBoundary.test.ts`, unchanged, over the pages it
edits; and `lib/preview/__tests__/platformCells.test.ts`, which reads
`lib/preview/__tests__/platformCells.ts::statedInDocs`: the two rows that hold it name
`content/docs/building-with-nova.mdx#preview-on-web-apps-and-android` (`PREVIEW_DOCS_SECTION`), a
heading A3 adds to and A11 leaves.

## 15. B14 in full: contracts and public docs for stack B

B14 lands, in one pull request: the root `CLAUDE.md` rows of section 6.2 marked B14 (fourteen
edits in seven places); `docs/architecture/contracts.md`, `complex-apps.md`, `deployment.md` and
`multilingual-localization.md` as section 6.4 writes them; the new page, `meta.json` and the eleven
pages of section 7.2; and, in `docs/plans/hq-round-trip/README.md`'s "Step 1 is done", "proofs 1 to
5, each judged over every reader" as "proofs 1 to 6, each judged over every reader" (part 14,
"Contracts").

Its order of work: the outcomes that change a public sentence are read from their pull requests'
descriptions (part 05's G2 and G7 for the circumstance rows the new page's account names; part 08's
E4 and part 10's G2 for the count of first-publish entries, which no page states); the texts are
written; H3 and H5 run; and its description carries the plugin pull request's link and H4's result
at B12's head.

What B14 does not do: it re-words no sentence A3 or A11 landed. It adds to two things A3 landed:
a paragraph to `publishing.mdx`'s "What stays as it is in CommCare HQ" (part 01, section 9.7), and
part 13's sentences to the `get_deployment` row of `mcp/tools.mdx` (section 7.2). It changes no
subtree `CLAUDE.md`, and it leaves `design/readme.md` to B11.

Its tests: the production build; `projectSpaceCompatibilityBoundary.test.ts`; and
`lib/publish/__tests__/hqFindingCopy.test.ts`, whose voice rules already hold the three labels and
the check-again line the new page quotes word for word from `lib/publish/hqFindingCopy.ts`.

## 16. B15 in full: removal of this plan

**What leaves.**

- `docs/plans/hq-round-trip/6-bring-in.md` and `docs/plans/hq-round-trip/6-bring-in/`, all fifteen
  parts. The outline this plan replaced is not B15's to remove: this plan's own pull request
  removed it (section 8.1).
- `scripts/scan-hq-app-claims.ts`, B8's one-off scan, run once before B8 merged.

**What does not leave.** `scripts/inspect-hq-readings.ts` (it runs again whenever a step 7 group is
planned); `.github/workflows/reader-scale.yml` and the `scale` Vitest project; every file of part 14, the
bases, variants and `proof/matrix/hand/hq-plain/document.ts` among them; `targeted-kept-values`; and
every test. A5's scan script, and its repair where one ran, are already gone, removed in the last commit
of A5's own pull request after their run. No Job, bundle line, allowlist arm or runbook exists to remove:
step 6 ran no cutover, and A5 removed whatever its repair added (section 5.3).

**What changes.**

- `docs/plans/hq-round-trip/README.md`: step 6's row becomes
  `| 6 | Bringing an app in from CommCare HQ | done: ["Step 6 is done"](#step-6-is-done) |`, with no
  link to the plan; the three bullets below are rewritten; and the section "Step 6 is done" is
  added after "Step 5 is done". This plan's own pull request left each of the three bullets with
  one link B15 removes, to `6-bring-in.md`'s section "What changed from the outline, and why". No
  bullet links the outline, so B15 re-points no such link. Each keeps its `7-rest-of-model.md`
  link:
  - "Step 3 is done": "**What step 3 left to later steps**, each with its reason, in
    [`7-rest-of-model.md`](7-rest-of-model.md); what step 4 took of it is in ["Step 4 is
    done"](#step-4-is-done), what step 5 took of it in ["Step 5 is done"](#step-5-is-done), and
    what step 6 took of it in ["Step 6 is done"](#step-6-is-done)."
  - "Step 4 is done", the bullet's second and third clauses: "the split's read-back and the guarded
    and `current()` reads, which step 6 took (["Step 6 is done"](#step-6-is-done)); a child module
    of a search-first parent, `fingerprintquery` and an ordinary search's results detail in
    [`7-rest-of-model.md`](7-rest-of-model.md)."
  - "Step 5 is done": "**What step 5 left to later steps**, each with its reason, in
    [`7-rest-of-model.md`](7-rest-of-model.md); what step 6 took of it is in ["Step 6 is
    done"](#step-6-is-done)."
- `docs/plans/hq-round-trip/7-rest-of-model.md`: each citation of this plan is re-pointed at where
  what endures lives, by the rule and the two tables below ("Where each enduring contract lives
  after" for a part cited whole, "How `7-rest-of-model.md` is re-pointed" for a section).

**Where each enduring contract lives after.**

| What this plan decided | Where it is read from B15 on |
|---|---|
| the bar, the six standings, the kept test (part 01) | `lib/commcare/CLAUDE.md`, "The surface manifest"; `docs/architecture/contracts.md`, "Some of an app stays CommCare HQ's."; `lib/commcare/surface/keptAtHq.ts` |
| findings and their copy (part 01) | `lib/publish/hqFindings.ts`, `hqFindingCopy.ts`, held complete by `hqFindingCopy.test.ts` |
| forms in the menu above; registration from the case list (part 02) | `lib/domain/CLAUDE.md`; `docs/architecture/complex-apps.md`, "Forms in the menu above" and "Register from the case list" |
| question display, calculated values, text shown as typed, a search with no title, blanks (part 03) | `lib/domain/CLAUDE.md`; `complex-apps.md`, "Question display and text" and the two paragraphs under the search workflow |
| the name grammars (part 04) | `lib/domain/CLAUDE.md`, `lib/lookup/CLAUDE.md`, `lib/commcare/xpath/CLAUDE.md` |
| reading CommCare HQ (part 05) | `lib/commcare/CLAUDE.md`, "Reading an app from CommCare HQ" |
| the reader (parts 06, 07, 08) | `lib/commcare/CLAUDE.md`, "The reader", "Reading case management back", "Reading expressions"; `complex-apps.md`, "How CommCare HQ rewrites a display condition and a filter" |
| acceptance and the first-publish register (part 09) | `lib/deployment/CLAUDE.md`, "Accepting a reading"; `lib/commcare/CLAUDE.md`, "Rewrites"; `contracts.md`, "HQ deployment safety" |
| identity, the claim, ending a deployment (part 10) | `lib/deployment/CLAUDE.md`, "Identities", "One HQ app, one Nova app", "Ending a deployment"; `lib/db/CLAUDE.md` |
| project data managed in CommCare HQ (part 11) | `lib/lookup/CLAUDE.md`, "Tables from CommCare HQ"; `lib/organization/CLAUDE.md`; `lib/media/CLAUDE.md` |
| the reading and the birth (part 12) | `lib/deployment/CLAUDE.md`, "Readings"; `lib/db/CLAUDE.md`; `contracts.md`, app birth |
| the experience (part 13) | `design/readme.md`, "Bringing in"; `components/builder/CLAUDE.md`; `content/docs/bringing-in-from-commcare-hq.mdx` |
| proof (part 14) | `proof/README.md`, `proof/CLAUDE.md` |
| the whole (this part) | `complex-apps.md`, "Bringing an app in from CommCare HQ"; the plans `README.md`, "Step 6 is done" |
| what step 6 left | `7-rest-of-model.md`, by group; the manifest's `owner` on every HELD-NEW entry |
| what planning found | `harness-findings.md`, "Found while planning step 6" |

**How `7-rest-of-model.md` is re-pointed.** That file cites this plan in five ways, and B15 rewrites
each by its kind, so that no sentence of it names a part, a pull request or a run once the plan has
left:

1. **A section, a Departure or a decision of a part** ("part 03, section 2.4", "part 07, Departure
   9"). It becomes the file and the named heading in the row below for that part and section. The
   pull request id beside it leaves with the plan.
2. **A part cited whole, with a pull request and no section** ("part 05, B1"). It becomes that
   part's row of "Where each enduring contract lives after", above.
3. **A row of a list a part writes** ("part 09, section 11.2, row 18"; "part 13, the review's
   sentence V21c and the publish dialog's D7"). The row number or copy id goes, and the id or
   sentence the file already writes beside it stands, with the file that holds the list: a
   first-publish change by its id in
   `lib/deployment/reading/firstPublishChanges.ts::FIRST_PUBLISH_CHANGES`, a sentence of the flow in
   `lib/publish/bringInCopy.ts`.
4. **A gated run** (part 15's H8; part 02's G3 and G6, part 07's G2, part 04's R2, part 01's Run 1
   and part 14's P1 and P2, all in the paragraph under the table of counts). Every run has answered
   by B15. That paragraph becomes one sentence giving the manifest's counts as they stand, read
   from `lib/commcare/surface/entries/` by `owner`, and the table of counts is corrected to them.
   The two mentions of H8 become "where the person has not run `scripts/inspect-hq-readings.ts`".
5. **The opening paragraph.** Its two links and its sentences on this plan and on B15 are replaced
   by: "It was written with step 6's plan, which has left this directory. What that plan decided is
   read where each sentence below points, and its summary is in
   [`README.md`](README.md#step-6-is-done)."

The table is built from the citations `7-rest-of-model.md` makes, one row for each part and each
set of its sections that one place receives. A heading in quotation marks is a heading of the file
named; where the contract is a table in code, the row names its symbol.

| Part | Cited in `7-rest-of-model.md` | Where it is read from B15 on |
|---|---|---|
| 01 | sections 2.2, 2.3 and 2.6 | `lib/commcare/CLAUDE.md`, "The surface manifest"; `lib/publish/hqFindings.ts::SUBJECTS` and `STEP_7_GROUPS` |
| 01 | section 3.5 | the cells of the entries it re-words, under `lib/commcare/surface/entries/`, each with its row under `docs/research/2026-09-26-hq-round-trip/inventory/` |
| 01 | sections 3.6, 4, 4.2, 4.3, 4.4 and 5 | `docs/architecture/contracts.md`, "Some of an app stays CommCare HQ's."; `lib/commcare/surface/keptAtHq.ts::KEPT_AT_HQ` |
| 01 | section 3.7 | the entry `application-and-settings/build-profiles-non-empty` in `lib/commcare/surface/entries/application-and-settings.json`, with its row in the inventory's `application-and-settings.md` |
| 01 | section 3.8 and Appendix A.1 | the manifest itself: each entry's disposition and, on a HELD-NEW entry, its `owner` (`lib/commcare/surface/entries/`); the plans `README.md`, "Step 6 is done" |
| 01 | section 7.1 | `lib/commcare/CLAUDE.md`, "The reader" |
| 01 | section 7.2 | `lib/deployment/CLAUDE.md`, "Baselines" |
| 01 | sections 8, 8.3 and 9 | `lib/publish/hqFindings.ts::READ_CIRCUMSTANCES` and `CIRCUMSTANCE_STANDINGS`; `lib/publish/hqFindingCopy.ts` |
| 02 | sections 3 to 9 | `lib/domain/CLAUDE.md`; `docs/architecture/complex-apps.md`, "Forms in the menu above" |
| 02 | sections 11 and 11.8 | `lib/domain/CLAUDE.md`; `complex-apps.md`, "Register from the case list" |
| 02 | sections 5.6 and 11.9 | the cells of the HELD-NEW entries whose `owner` is `menus`, in `lib/commcare/surface/entries/menus-and-case-lists.json`; `complex-apps.md`, the same two subsections |
| 02 | section 12 and decision 16 | `lib/agent/authoring/reference.ts`, the menus section; `lib/agent/tools/media/setMenuMedia.ts` |
| 03 | sections 2, 2.1, 2.4 and 3 | `lib/domain/CLAUDE.md`; `lib/domain/fieldDisplay.ts::FIELD_DISPLAY_SETTINGS`; `complex-apps.md`, "Question display and text" |
| 03 | sections 4, 8 and 8.3 | `complex-apps.md`, "Question display and text"; `lib/domain/CLAUDE.md` |
| 03 | sections 6 and 7 | `complex-apps.md`, "Case lists, search, and the case workspace", the two paragraphs after "The search workflow"; `lib/domain/CLAUDE.md` |
| 04 | sections 2.2, 2.3 and 11.2 | the cells of the entries A9 splits and adds, under `lib/commcare/surface/entries/`; `lib/domain/CLAUDE.md` |
| 04 | section 6 | `lib/domain/CLAUDE.md`; `complex-apps.md`, the reserved write properties |
| 04 | section 9 | `lib/lookup/CLAUDE.md` |
| 05 | sections 7, 10 and 10.2 | `lib/commcare/CLAUDE.md`, "Reading an app from CommCare HQ" |
| 06 | sections 2.2, 6.5, 7.1 and 16.5 | `lib/commcare/CLAUDE.md`, "The reader"; `lib/commcare/reader/types.ts::ReaderInput` for a reading's inputs |
| 06 | sections 9.2, 10.4 and 12.5 | `lib/commcare/CLAUDE.md`, "The reader", its second paragraph |
| 07 | sections 3 to 7 (3.7 among them); Departures 4, 5 and 9 | `lib/commcare/CLAUDE.md`, "Reading case management back"; `lib/deployment/CLAUDE.md`, "Placements" |
| 07 | sections 8 to 10 | `lib/commcare/CLAUDE.md`, "Reading case management back" and "After-submit links (`form_links`)" |
| 07 | sections 11, 12 and 12.3; Departures 1, 2, 3, 7 and 10 | `lib/commcare/CLAUDE.md`, "Case-list emission" and "Case-search emission", the sentence each holds on its reader |
| 07 | section 14 | the cells of the entries B4 and B5 add and re-cut, under `lib/commcare/surface/entries/` |
| 08 | sections 6.3, 8, 8.1, 9 and 9.2 | `lib/commcare/CLAUDE.md`, "Reading expressions"; `lib/commcare/xpath/CLAUDE.md`, "Parsing and identity" |
| 08 | sections 7.5, 7.6 and 8.3 | `lib/commcare/CLAUDE.md`, "Reading expressions"; `complex-apps.md`, the case search sentence that begins "A search reads `today()` as the worker's day"; `lib/agent/authoring/CLAUDE.md`, the record dialect's value spellings |
| 09 | sections 9 and 9.1 | `lib/deployment/CLAUDE.md`, "Accepting a reading"; `lib/commcare/reader/canon.ts::CANONICALIZATIONS` |
| 09 | sections 11.1 and 11.2 | `lib/deployment/reading/firstPublishChanges.ts::FIRST_PUBLISH_CHANGES`; `lib/commcare/CLAUDE.md`, "Rewrites"; `proof/README.md`, "First-publish changes" |
| 10 | sections 2.1 to 2.3, 2.5 and 3 | `lib/deployment/CLAUDE.md`, "Identities"; `lib/commcare/reader/identity.ts` |
| 10 | section 4 | `lib/deployment/CLAUDE.md`, "Identities"; `lib/media/CLAUDE.md` |
| 10 | section 5 | `lib/deployment/CLAUDE.md`, "One HQ app, one Nova app" |
| 10 | section 8 | `lib/deployment/CLAUDE.md`, "Ending a deployment" |
| 10 | sections 9 and 10 | `lib/deployment/CLAUDE.md`, "Baselines" |
| 11 | section 4.4 | `lib/media/CLAUDE.md` |
| 11 | sections 5 to 9 (5.2, 5.3, 5.4, 7, 8.1 and 9 among them) | `lib/lookup/CLAUDE.md`, "Tables from CommCare HQ"; for the re-read before a publish, `lib/deployment/CLAUDE.md`, "Preflight is a graph with two kinds of edge" |
| 11 | sections 11.2, 11.3 and 11.4 | `lib/organization/CLAUDE.md` |
| 11 | section 13.1 | the cells of the entries B9 edits and splits, in `lib/commcare/surface/entries/expressions-and-data.json` |
| 11 | section 13.2 | `lib/publish/hqFindings.ts::READ_CIRCUMSTANCES` |
| 12 | sections 8.1 and 8.2 | `lib/deployment/CLAUDE.md`, "Readings"; `lib/deployment/reading/census.ts`; `scripts/inspect-hq-readings.ts` |
| 13 | section 11.3 and Departure 12 | `components/builder/CLAUDE.md`, "Publishing"; `design/readme.md`, "Bringing in" |
| 14 | section 5 | `proof/README.md`, "Proofs 1 to 6" |
| 14 | section 7.5 | `proof/README.md`, "Apps made in CommCare HQ"; `lib/commcare/surface/__tests__/entryCoverage.test.ts` |
| 14 | section 8 | `proof/README.md`, "Parity with Nova's reader" |
| 14 | section 9 | `proof/README.md`, "First-publish changes" |
| 14 | Departure 8 | `proof/README.md`, "How the lane observes" |
| 15 | section 16 | the opening paragraph, by kind 5 above |

A citation this table does not hold is one `7-rest-of-model.md` gained after this plan merged. The
pull request that adds it also adds its row here, and B15 refuses to merge with one unmatched: it
runs `rg -n -i "\bparts? [0-9]{2}\b" docs/plans/hq-round-trip/7-rest-of-model.md`, which prints
nothing at its head.

**"Step 6 is done"**, written by B15:

> ## Step 6 is done
>
> Step 6 made an app that lives in CommCare HQ something Nova can bring in whole, hold typed, and
> publish back to the same app, and its plan has left this directory. It shipped as two stacks with
> two ordinary deploys and no cutover: first what a plain app holds, then the reader and the
> experience. What endures lives where it is read:
>
> - **What a plain app holds**: a menu that shows its forms in the menu above, and registration from
>   a case list at any time (`lib/domain/CLAUDE.md`; `docs/architecture/complex-apps.md`, "Forms in
>   the menu above" and "Register from the case list"); the Phone Number question, a calculated
>   value in text, text shown as typed, a search with no title and where blanks sort
>   (`complex-apps.md`, "Question display and text"); and the names CommCare HQ's editors accept
>   (`lib/domain/CLAUDE.md`, `lib/lookup/CLAUDE.md`).
> - **What stays CommCare HQ's**, `lib/commcare/surface/keptAtHq.ts` and `TargetFacts`
>   (`docs/architecture/contracts.md`, "Some of an app stays CommCare HQ's.";
>   `lib/deployment/CLAUDE.md`, "Baselines").
> - **A standing for every manifest entry**, with the noun a person reads and the step 7 group that
>   will hold it (`lib/commcare/CLAUDE.md`, "The surface manifest"), and the findings a person is
>   shown (`lib/publish/hqFindings.ts`, `hqFindingCopy.ts`).
> - **The reader**, `lib/commcare/reader/`: one pure function from CommCare HQ's answers to a
>   document, its identities and its findings (`lib/commcare/CLAUDE.md`, "Reading an app from
>   CommCare HQ", "The reader", "Reading case management back", "Reading expressions").
> - **Acceptance and what a first publish changes**, `lib/deployment/reading/`
>   (`lib/deployment/CLAUDE.md`, "Accepting a reading"; `lib/commcare/CLAUDE.md`, "Rewrites";
>   `contracts.md`, "HQ deployment safety").
> - **Identity and the ledger**: CommCare HQ's own ids and media paths on the project space an app
>   came from, one HQ app to one Nova app, and a deployment a person can end
>   (`lib/deployment/CLAUDE.md`, "Identities", "One HQ app, one Nova app", "Ending a deployment";
>   `lib/db/CLAUDE.md`).
> - **Project data managed in CommCare HQ** (`lib/lookup/CLAUDE.md`, "Tables from CommCare HQ";
>   `lib/organization/CLAUDE.md`; `lib/media/CLAUDE.md`).
> - **The reading and the birth**, `hq_app_readings` and the `hq-adoption` birth
>   (`lib/deployment/CLAUDE.md`, "Readings"; `lib/db/CLAUDE.md`; `contracts.md`, app birth).
> - **The experience**: the flow on `/build/new`, the account, the review and the tools
>   (`design/readme.md`, "Bringing in"; `components/builder/CLAUDE.md`; the public page
>   `content/docs/bringing-in-from-commcare-hq.mdx`).
> - **The proof lane**: apps made in CommCare HQ's own pages as a sixth corpus source, proof 6,
>   parity with the reader and the first-publish register (`proof/README.md`), with both defect
>   registers unchanged and `OPEN_DEFECTS` empty.
> - **What planning step 6 found**,
>   [`harness-findings.md`](../../research/2026-09-26-hq-round-trip/harness-findings.md), "Found while
>   planning step 6".
> - **What steps 3 to 5 left, and what step 6 took of it.** Of step 3's: expressions read back by
>   one recognition method, a search's `_xpath_query` rows by conjunct, and a calculated value in
>   text (`lib/commcare/CLAUDE.md`, "Reading expressions"; `complex-apps.md`, "Question display and
>   text"). Of step 4's: the declaration proposed from an app's content and chosen in the review,
>   media judged by platform, the date-and-time split read back as ordinary questions, and the
>   guarded and `current()` reads (`lib/commcare/CLAUDE.md`, "The reader", "Reading expressions").
>   Of step 5's: every placement held at CommCare HQ's own position, links read in reverse, the
>   search workflow read from its three settings, and text shown as typed (`lib/commcare/CLAUDE.md`,
>   "Reading case management back"; `lib/deployment/CLAUDE.md`, "Placements"). What step 6 left of
>   them is in [`7-rest-of-model.md`](7-rest-of-model.md).
> - **What step 6 left to step 7**, each with its owner, in
>   [`7-rest-of-model.md`](7-rest-of-model.md); `scripts/inspect-hq-readings.ts` orders its groups.
> - **The baseline step 6's plan was written against**: `main` at `15a00a97`, at the CommCare pins
>   named under "Rules every plan follows".
> - **No cutover, so no trace of one.** Step 6 migrated no document and wrote no notice. What it
>   left in the database is four ledgered migrations, each with its test
>   (`lib/case-store/migrations/`).
>
> The `../nova-plugin` change rides stack B: the pull request B14's description links takes the
> plugin to `2.5.0`, and it merges once the deploy carrying stack B is live.

B15 writes the plugin pull request's number and link in place of the last paragraph's description
of it, as step 5's section does. Where A5's repair ran (section 5.3), B15 writes the last bullet's
second sentence as "Step 6 migrated no document by a cutover and wrote no notice; one repair ran
before the first stack merged, on the apps a person approved by id, each holding its
`blueprint-migration` row by `system:case-list-registration-registrations`, and its scripts are
removed."

**Its checks.** `git grep -l -E '6-bring-in|6-import' -- . ':!docs/research'` returns nothing;
`git ls-files docs/plans/hq-round-trip` lists `README.md` and `7-rest-of-model.md`; `git diff --stat
<B14>..<B15> -- lib app components proof` is empty, so the gate, the reader and the lane the stack
merged are the ones B14's head proved; and after the merge, run H7.

## Departures

This part's own, beside the plan's (section 12): departures from step 5's rules, and decisions
where an alternative was weighed and not taken. A row that begins "Not done" names the alternative
an implementer could reach for.

| From, or the alternative not taken | This part | Reason |
|---|---|---|
| Not done: A10 as the pull request that writes the stack's final guide and moves `MODEL_CONTEXT_VERSION` once, beside the billed schema check | A10 writes no guide sentence and no literal unless a correction forces one; its diff is six prompts of `scripts/test-schema.ts` | each of A4 to A9 changes a served tool or the guide and must move the literal itself (`lib/agent/CLAUDE.md`; section 1.3 here), so nothing is left for A10 to assemble but the reading and the ask |
| Step 5's rule that the root `CLAUDE.md`'s rows move with their behavior | the root's stack B sentences land in B14; only the `proof/` bullet moves with its behavior (A1, B13) | they describe bringing an app in as one thing, which no person can reach before B11, and every subtree contract an implementer works under is true at every head |
| Step 5's rule that every public page lands in the contracts pull request | A3 lands its own three pages and its `contracts.md` paragraph | its `KEPT_AT_HQ` cells and export advisories point at the section it writes (section 7 here; part 01, sections 5 and 9.7) |
| Not done: a nova-plugin pull request for each stack, whatever its sweep finds | stack B's is part 13's; stack A's exists only where the sweep finds a sentence stack A makes false, and at `0a67203` it finds none | a pull request with no edit has nothing to review; the sweep is repeated at A10's head and its result recorded |
| Not done: splitting a pull request because it is large to review | none is split | section 2.2: no candidate has two halves that are each green and each a complete behavior without cutting a migration, a literal or the lane's keys |
| Not done: leaving the root `CLAUDE.md`'s mental model 3 as it stands | its clause "a one-way emission boundary" is rewritten in B14, as part 06's "Contracts" says | the reader makes it false; the sentence part 06 meant, "The SA and the builder never speak CommCare.", is unchanged |
| Not done: B1 adding the heading "Found while planning step 6" to `harness-findings.md` | the plan's own pull request writes it, as part 05's "The harness findings" says | one heading, written once, from every part; a stack pull request writes there by the one rule of section 8.1 |
| Beyond the parts | eleven contract sentences, two source comments, the Biome rule's message, one manifest cell, one sentence of `proof/README.md`, and a new `complex-apps.md` section "Bringing an app in from CommCare HQ" | each was read false or incomplete at `main` against what the stacks build, and the plan's rule is that docs move with behavior; the new section is where the binding facts of the whole are read once the plan is gone |
| Not done: leaving the Biome rule's message as it is | its first sentence is rewritten in B7, as part 06's section 2.4 and part 09's "Contracts" say | the message calls `lib/commcare` a one-way emission boundary, the clause B14 takes out of the root `CLAUDE.md` as false; B2 still changes no line of `biome.json` |
| Not done: stack B's billed check held to two named entries, with no other sent | E1's list is the hash run's, with those two expected, as part 13's run E1 says | a hash move the stack records and the check does not send would be a served schema nobody asked the provider about |
| Not done: no Job under every outcome of A5's scan | one fenced repair, only on the A5 scan's "Some found" outcome and only for an app the person said yes to | part 02 has a script change a production app in that outcome, and the repository writes a production document one way; on the expected outcome there is no Job (section 5.3) |
| Not done: the census as the only order step 7's groups can take | the census orders them (H8, outcome A); where the census shows no not-yet finding, the outline's own order stands until it does (H8, outcome B) | an order needs a reading to rest on |

## Files by pull request

Every other pull request's files are in section 1.4.

- **This plan's own pull request**, beneath stack A: `docs/plans/hq-round-trip/6-bring-in.md`,
  `docs/plans/hq-round-trip/6-bring-in/` (fifteen parts), `docs/plans/hq-round-trip/7-rest-of-model.md`
  (rewritten, section 8.4), `docs/plans/hq-round-trip/README.md` and
  `docs/research/2026-09-26-hq-round-trip/harness-findings.md` (section 8.1); and it deletes the
  outline's file, which `6-bring-in.md` names.
- **A10**: `scripts/test-schema.ts` (the six prompts of section 13.3; the header's names). Only
  under H1's outcome B: the corrected tool's file under `lib/agent/tools/` or
  `lib/agent/toolSchemaGenerator.ts`, `lib/agent/authoring/reference.ts`, `lib/models.ts`
  (`"v7-hq-round-trip-bring-in.a10"`) and `lib/mcp/__tests__/servedSchemas.test.ts`. Only where a
  moved tool was left unregistered: its entry in `scripts/test-schema.ts`.
- **A11**: `docs/architecture/complex-apps.md`; `content/docs/nested-menus.mdx`,
  `display-conditions.mdx`, `form-links.mdx`, `deep-links.mdx`, `case-workspace.mdx`,
  `where-workers-use-your-app.mdx`, `building-with-nova.mdx`, `commcare-connect.mdx`,
  `case-changes.mdx`, `mcp/tools.mdx`.
- **B14**: `CLAUDE.md` (root); `docs/architecture/contracts.md`, `complex-apps.md`, `deployment.md`,
  `multilingual-localization.md`; `content/docs/bringing-in-from-commcare-hq.mdx` (new),
  `meta.json`, `index.mdx`, `building-with-nova.mdx`, `publishing.mdx`,
  `project-space-compatibility.mdx`, `case-workspace.mdx`, `projects.mdx`, `project-data.mdx`,
  `organization.mdx`, `mcp/tools.mdx`, `claude-code/commands.mdx`, `claude-code/quickstart.mdx`;
  `docs/plans/hq-round-trip/README.md` ("proofs 1 to 6").
- **B15**: deleted, `docs/plans/hq-round-trip/6-bring-in.md`, `docs/plans/hq-round-trip/6-bring-in/`,
  `scripts/scan-hq-app-claims.ts`; changed,
  `docs/plans/hq-round-trip/README.md` ("Step 6 is done", the row and the three bullets) and
  `docs/plans/hq-round-trip/7-rest-of-model.md` (its citations of this plan).
- **`../nova-plugin`**, its own repository: stack B's pull request, as part 13's section 16 lists
  its files (`skills/bring_in/SKILL.md`, `skills/upload_to_hq/SKILL.md`, their `.dev-plugin/skills/`
  mirrors, both `plugin.json` files, `README.md`); stack A's only under H4's outcome B.

## What this part reads from the others

- **Every part**: its "Files by pull request" (section 1.4), its "Contracts and docs these changes
  make false" (sections 6 and 7), its "Departures" (section 12), its "Written and not yet run"
  (section 10) and what it leaves step 7 (section 8.4). Where a row here rests on a part's wording,
  the part's section is the text.
- **Part 01**: A2's and A3's contents and counts; that A3 lands its own public pages and its
  `contracts.md` paragraph, which A11 does not re-word; the circumstance counts 20, 27, 28, 34, 35;
  the issues A2's and A3's implementers file (its sections 3.7 and 6.4); Run 1, Run 2 and Run 3; the
  last paragraph of its section 9.7, which B14 lands; the `kept` sentence the stack B plugin pull
  request carries.
- **Part 02**: A4 and A5; the two guide paragraphs of its section 12; its section 2 table and its
  sections 4.3, 10.2 to 10.4 and 11.4, from which section 6.3 here is worded; its "Contracts" text
  for seven public pages; runs G1 to G6 and the A5 scan.
- **Part 03**: A6 to A8; its "Copy" for the guide; its sections 3.1, 4.4, 5, 6, 7 and 8.1, from
  which section 6.3 here is worded; its "Contracts" text for three public pages by G5's outcome;
  that A7 registers `setFormSections`; the wording of the issue filed before A7 (part 01 words the
  two filed before A2 and A3); runs G1 to G5.
- **Part 04**: A9; its section 13 table of moved tools and its rule for a mismatch; its three
  `complex-apps.md` texts and five public sentences; the migration and its `down`; runs R1 and R2.
- **Part 05**: B1; that its seven runs are made on its branch before it opens; the classification
  every later part reads; its hand-off of stack B's public pages to B14.
- **Part 06**: B2 and B3; the files it carries for parts 08, 10 and 12; its text for the root
  `CLAUDE.md`'s `lib/commcare` bullet; runs R1 and R2, with `reader-scale.yml`.
- **Part 07**: B4 and B5; what it lands in B6 and B13; its ask of part 09's row 16 (section 12.3);
  runs G1 to G4.
- **Part 08**: B6; `.b6`; that it creates the rewrite registry; its two `complex-apps.md` texts, its
  `list(...)` sentence and its sentences C13 and C14 for B14; runs E1 to E6.
- **Part 09**: B7 and stack B's order; the register's count, its renderer and its one stored home;
  its `contracts.md` bullet and its `publishing.mdx` paragraph for B14; runs K1 to K4.
- **Part 10**: B8; the migration's statements and what is not safe to roll back to; the scan
  `scripts/scan-hq-app-claims.ts`, which B15 removes; its text for the root's mental model 3,
  `contracts.md` and `publishing.mdx`; how it settles two of the research's rows; runs G1 and G2.
- **Part 11**: B9; the migration; `.b9` and the `getOrganization` entry; its "Copy" T, O and P
  rows, from which section 7.2 here is worded; its section 12.4 for the four `mcp/tools.mdx` rows;
  how it settles three of the research's rows; runs R1 and R2.
- **Part 12**: B10; the migration and the privilege class; the six routes and the allowlist they
  need no entry in; `scripts/inspect-hq-readings.ts`, which stays, and its first table, which orders
  step 7; its text for `contracts.md`, `deployment.md` and the root `CLAUDE.md`; run M1, the
  check's memory at Nova's ceiling, with `--memory=2Gi` on the `deploy` step.
- **Part 13**: B11 and B12; `.b12`; run E1 and its question; the plugin's pull request in full; its
  section 17 for every public page of stack B; its two sentences for the root `CLAUDE.md`.
- **Part 14**: A1 and B13; each pull request's proof lines and the cost of a lane, a night and a run
  by hand; that stack B merges no sooner than the first green night after stack A; runs P1 to P8;
  its Departure 7, which words the exit; the README's "proofs 1 to 6".
