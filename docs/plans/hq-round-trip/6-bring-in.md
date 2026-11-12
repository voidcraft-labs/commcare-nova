# Step 6: Bringing an app in from CommCare HQ

Step 6 lets a person bring in an app from CommCare HQ. They choose an app in a project space they are
connected to, Nova reads it, and one of two things follows. Either a Nova app exists that holds the
whole app typed and publishes back to that same HQ app, or the person has an account of everything
that keeps the app out, grouped by where it sits in their app, with what to do about each thing: what
Nova cannot hold yet, what Nova does not bring in, and what needs changing in CommCare HQ. A read
that cannot finish (no connection, no API access, a linked app) stops and says why, with nothing
created. Nothing comes in by halves: an app Nova held part of would lose the rest at its first
publish. In every word a person reads the feature is "Bring in an app from CommCare HQ" and its verb
is "bring in".

This plan replaces the outline `6-import.md`, which the pull request that adds this file removes; the
outline is readable at `main` `15a00a97`, and every part cites it as "the outline", by item. The plan
settles the outline's ten items and the cutover and exit it gave the step; it makes eight things a plain
HQ app holds complete Nova features, because without them nearly no real app would come in; and it fixes
three defects of today's Nova found while planning: Preview's case list filter does not fold accents as
CommCare does (part 01), label text holding `instance(` reaches CommCare HQ's instance scan (part 03,
whose run G2 holds that read against HQ's own build before A7 merges and writes what lands under each
outcome), and `lib/commcare/hq/publishedCaseBlocks.ts::publishedCaseBlocks` passes over a form it cannot
read (part 07). Three more defects found while planning are not fixed in step 6. Each is filed as an
issue by the implementer of the pull request beside it, assigned to themselves, before that pull request
opens, and named there by number: a language removed in Nova stays in CommCare HQ's build profiles, which
step 7's group `settings-nova-comes-to-own` comes to fix (before A2; part 01, section 3.7); Preview keeps
a filtered tile list's groups in their unfiltered order, where Web Apps orders them by each group's first
match (before A3; part 01, section 6.4); and a Connect block's name or description holding `instance(`
reaches the same scan, where no protected spelling exists (before A7; part 03, "What this part needs of
other parts"). It also keeps two of today's behaviors from reaching a brought-in app or its Project: a
publish to the project space an app was brought in from no longer writes fifteen absent settings as
forced ones, which would reset workers' own choices on their phones (part 01, section 7.3), and a second
app of a Project is no longer asked to take over the Project's own lookup table (part 11). It ships as
two stacks of twenty-six pull requests with one ordinary deploy each: "What a plain app holds" (A1 to
A11), then "Bring in" (B1 to B15). It adds four additive database migrations, migrates no stored
document, takes no maintenance window, and leaves both defect registers as they are, the known one empty.

This file is the plan. It holds the baseline the plan was written against, the decisions that depart from
the outline and the research, the decisions where an alternative was weighed and not taken, one work item
for each pull request with where it is planned in full, the stacks, the migrations, the contracts, what
step 7 is left, and the exit. The detail (schemas, DDL, files, manifest moves, tests, copy) is in fifteen
part files beside it, [`6-bring-in/`](6-bring-in/). **The parts bind and this file summarizes**: where a
sentence here and a part differ, the part stands, and where two parts differ on a point part 15's section
12.3 names, its row stands. That section holds thirteen decisions that each settle one point for every
part it touches, and each part it names says the same. Nothing outside the repository and the pinned
sources binds: every decision is stated in this file or in the part that owns it, with its evidence. A
session implementing one pull request reads this file, that pull request's row and file list in part 15,
and every part the row names. Nothing here or there is left to decide during implementation: where a run
outstanding decides a fact, every one of its outcomes is written out in full. Every claim about what
CommCare does was read at the pins during planning; "Written and not yet run" below lists every gated
execution and where each outcome is written.

| Part | Plans | Pull requests |
|---|---|---|
| [01](6-bring-in/01-the-bar-and-the-manifest.md) | The bar made mechanical: the six standings, `subject` and `owner` on the manifest, value classes, every row re-cut by value, the kept test with the table `KEPT_AT_HQ`, `TargetFacts` and its three readers (the `.ccz`, Preview, the Publishing card), the finding type, every circumstance and the complete finding copy | A2, A3; the manifest and copy lines of B1 to B10 |
| [02](6-bring-in/02-menus.md) | A menu that shows its forms in the menu above, and registration from the case list always offered, each across the domain, the validator, both emitters, Preview, the builder, the tools, the platform table and proof | A4, A5 |
| [03](6-bring-in/03-questions-and-text.md) | The typed question display vocabulary and the Phone Number question, a calculated value in prose, text CommCare HQ reads as an instance, a search with no title, a sort rule's blanks, text shown as typed | A6, A7, A8 |
| [04](6-bring-in/04-names.md) | All forty-five `widen` rows decided: the name grammars built, the classes that stay not-yet, the one lookup migration, `widen` leaving the manifest's schema | A9 |
| [05](6-bring-in/05-reading-commcare-hq.md) | What the HQ client gains: the app list, the application resource, the wider source read, the bracketed read, form alignment, media bytes, API access checked first, one retry rule, one classification of every failed answer | B1 |
| [06](6-bring-in/06-the-reader-forms.md) | The reader's frame (the package, `readHqApp`, the manifest at run time, the accounting cursor, the claim log, findings and places, assembly, the declaration choices) and the whole reading of a form's source | B2, B3 |
| [07](6-bring-in/07-the-reader-cases-menus-lists.md) | The reader of case management with each placement held, menus, after-submit links, deep links, case lists and search, each rule the inverse of an emitter | B4, B5 |
| [08](6-bring-in/08-the-reader-expressions.md) | The one recognition method and its closed equivalence table, the folds, HQ's interpolation ported, record slots, the reader of search filter rows, the rewrite registry begun | B6 |
| [09](6-bring-in/09-acceptance-and-the-first-publish.md) | `acceptReading` and its five checks, the canon list, `EMISSION_REWRITES` completed, the closed register `FIRST_PUBLISH_CHANGES` with every entry and sentence, `read-back-differs` | B7 |
| [10](6-bring-in/10-identity-and-the-ledger.md) | The `IdentityResolver`, identity rows and media paths for an adopted deployment, the claim of one HQ app by one Nova app, the adopted ledger at birth, ending a deployment, drift wording by origin, the ledger migration | B8 |
| [11](6-bring-in/11-project-data.md) | Media fetched, judged and published; lookup tables and places as copies managed in CommCare HQ; a tag that meets a Project table; the re-read before a publish; ownership derived from the Project's live mappings | B9 |
| [12](6-bring-in/12-the-reading-and-the-birth.md) | The durable `hq_app_readings` row, the service that advances it by bounded steps, the six routes, the review digest, the `hq-adoption` birth, the receipt's adoption arm, the census | B10 |
| [13](6-bring-in/13-the-experience.md) | The three entries, the flow as a state of `/build/new`, every screen and string, the home list, what the Publishing card and the Publish dialog say afterwards, six MCP tools, the guide, the plugin skill, the public docs' text | B11, B12 |
| [14](6-bring-in/14-proof.md) | The sixth corpus source and the probe, the twenty-two bases, variants and coverage, proof 6, parity, the first-publish judge, every pull request's proof lines, cost | A1, B13 |
| [15](6-bring-in/15-stack-contracts-and-exit.md) | Both stacks in full with files by pull request, ordering, house rules, the model-addition checklist, the migrations and production reads, every contract and docs sentence that changes, every gated run, the exit, every departure | A10, A11, B14, B15 |

## The baseline this plan was written against

**Nova.** `main` at `15a00a97` (#897), which is step 5's plan and stack (#832, #837 to #855) merged
and its cutover run, with what merged after them
([`README.md`](README.md), "Nova since the research"). What it holds that step 6 builds on, or stops:

- **Nothing reads an app from CommCare HQ.** `lib/commcare/reader/` does not exist, and the root
  `CLAUDE.md` calls `lib/commcare` a one-way emission boundary. The HQ client reads an app's source
  for the drift check (`lib/commcare/hq/appSource.ts::readHqAppSource`), its builds
  (`lib/commcare/client.ts::listAppBuilds`), lookup tables and places, through four hand-written
  status ladders (part 05, section 1).
- **A manifest that refuses what HQ's own pages write.** `lib/commcare/surface/entries/` holds 1,250
  inventory entries: 472 HELD, 237 HELD-NEW, 26 TARGET-OWNED, 166 INERT and 349 REFUSED. No entry
  carries a noun a person reads or the step that will hold it, forty-five `widen` changes sit on HELD
  rows, and production code reads only the gate entries (`lib/commcare/surface/gates.ts`); the six
  area files are read by tests and the lane (part 01, section 1; part 06, section 3).
- **One genesis writer with three callers.** `lib/db/appGenesis.ts::createExplicitBlankApp` and, in
  `lib/agent/change-set/materializeGenesis.ts`, `materializeAppFromGenesis` and
  `materializeSessionGenesis` all write through
  `lib/db/appGenesis.ts::writePreparedGenesisInTransaction`, which writes no lookup table, no place
  and no deployment, and `lib/db/CLAUDE.md` holds the closed birth owner `explicit-blank |
  design-slice`. Every birth hands the client one twelve-key receipt that lands without a route
  change (part 12, section 1).
- **Identity is derived, and the ledger knows two ownerships.** A menu's and a form's HQ id and a
  form's `xmlns` come from the Nova UUID (`lib/commcare/wireIdentity.ts::targetWireIdentity`);
  `app_deployment_identities` is runtime read-only and holds only what step 2's cutover wrote; every
  media file is written at `commcare/<sha256><ext>` (`lib/media/manifest.ts::resolveMediaManifest`);
  `app_deployment_resources.ownership` is `nova-created | adopted`, both writers of an `app` mapping
  write `nova-created`, nothing asks whether two Nova apps map one HQ app, baselines have the origins
  `create | push | cutover | unread`, and no deployment can be ended (part 10, section 1).
- **Project data is Nova's to write.** A lookup mapping is per deployment, so a second app of one
  Project that shares a table is asked to take over Nova's own table, and neither `lib/lookup` nor
  `lib/organization` has a state in which a table or a set of places is read and never written (part
  11, section 1).
- **Long work is one request.** A publish is one `POST /api/commcare/upload`, an MCP call is capped
  at 300 seconds (`app/api/mcp/dispatch.ts::MCP_MAX_DURATION_SECONDS`), durable work before an app
  exists is a `design_sessions` row shaped around a model run, and `/api/commcare` is on the main
  host's allowlist (`lib/hostnames.ts::HOSTNAME_ALLOWLIST`), so every route beneath it is reachable
  (part 12, section 1).
- **What steps 2 to 5 left that the reader stands on:** one `Expression` union with its checker and
  one wire tree and serializer (step 3); the declaration `appSettings.runsOnlyOn`, the platform
  table and `lib/doc/platformDeclaration.ts` with the date-and-time split (step 4); one concept for a
  form's case writes, held placements, `publishedCaseBlocks`, advanced modules,
  `caseSearchConfig.workflow` and `formsReadSearch`, `Module.caseListMenuItem` and
  `Module.caseListRegistrationForm` (one arm, `after-empty-search`), `Form.otherwise`,
  `group.fieldList` and `plainLabel` (step 5). #870 took every Postgres identifier off case type and
  property names, which the wider name grammars rest on, and #887 keeps authored prose literal
  through the XML export, which calculated values in prose build on.
- **The lane and its registers.** Five corpus sources, every document a Nova document
  (`proof/corpus/documents.ts::CorpusSource`), 430 documents and 108 controls;
  `proof/known-defects.json` `[]`, `proof/fixed-defects.json` 1,017 entries,
  `proof/checks/registers.py::OPEN_DEFECTS` `{}`, `proof/walk-stops.json` 25 entries, and
  `proof/identity-moves.json` scoped to the eight migration witnesses. The lane runs no Nova
  TypeScript in a shard, and `proof/corpus/hq/` harvests HQ's own apps for nothing to read (part 14,
  section 1).
- **Versions.** `lib/models.ts::MODEL_CONTEXT_VERSION` `"v6-hq-round-trip-case-writes.14"`,
  `lib/db/appTests.ts::RUNTIME_VERSION` 18, `scripts/test-schema.ts::SCHEMA_TESTS` 63 entries, the
  newest migration `lib/case-store/migrations/20261112010000_retained_conversation_sources.ts`, and
  `../nova-plugin` at `0a67203` with `.claude-plugin/plugin.json` at `2.4.2` and
  `.dev-plugin/.claude-plugin/plugin.json` at `1.31.0`.

**CommCare.** Every fact this plan relies on was read, and where reading left doubt it is planned as
a run, at the commits `proof/pins.json` names, unchanged since step 2: commcare-hq `d6c6e16d8ae1`,
commcare-core `8e9ba8d908e9`, commcare-android `7a5584475580`, commcare-connect `046c7fd78081`,
formplayer `24383ac71bfb`, and Vellum `01215f251c57`, the build HQ vendors at that pin. Citations are
`file::symbol`.

**Executed during planning.** Each part's "Executed during planning" gives what it read and what it
showed. The reads that decided the plan:

- **Nova at `15a00a97`**, by `rg` and reading the enclosing symbol: every fact under "Nova" above,
  each with its `path::symbol` and the part and section that holds the read (the manifest and its
  gates, the HQ client, the genesis writer, the deployment ledger, lookup, organization and media,
  the request and MCP limits, the lane and its registers, the versions), and the research under
  `docs/research/2026-09-26-hq-round-trip/`, read against that code and the pins.
- **The central finding: the outline's strict reader would have refused nearly every real HQ app.**
  A just-created HQ app is held, inert or kept in every part. A real one is not, because HQ's own
  pages write values the manifest refused, with no author choosing anything. The paths cited in this
  bullet are under commcare-hq's `corehq/apps/app_manager/`. A save of the Case List page writes
  `case_tile_field: ""` on every column
  (`static/app_manager/js/details/bootstrap5/column.js::serialize`), and the one entry naming that
  key was HELD-NEW with no value class; it writes `blanks` on every sort row
  (`static/app_manager/js/details/bootstrap5/sort_rows.js::sortRow`), HELD-NEW for both values,
  though Nova has written the same values since step 2. A save of the Settings page stores every
  enabled profile setting at HQ's default (`views/settings.py::edit_commcare_profile`),
  `cc-fuzzy-search-enabled: yes` among them, where Nova holds only its own constants. A search with
  no title typed stores a blank `title_label`
  (`views/modules.py::_gather_and_update_search_properties`), HELD-NEW. And each of the four
  directories under `static/app_manager/template_apps/` (HQ's three starter apps and a second copy
  of one, which is no base of the lane) holds `mobile_ucr_restore_version: "1.0"`, which the
  manifest REFUSED as retiring, and at least two menus with `put_in_root: true`, with a
  `case_list_form` outside a search beside them, both HELD-NEW (part 01, sections 3 and 4; part 02,
  sections 2 and 10; part 03, sections 6 and 7; part 14, "Executed during planning"). Read as
  written, the outline's exit would have refused HQ's own starter apps on several counts each, and
  an account would have been the common result of the step. **That is why step 6 gained stack A**:
  the rows HQ writes on a save are re-cut by value, what Nova's publish never writes is kept at
  CommCare HQ's value, and the concepts a plain app holds are built as complete features before the
  reader lands.
- **The CommCare reads at the pins**, in the checkouts, by `rg` and reading the enclosing function:
  `Application`'s every declared property, its import, its profile and its suite sections (part 01);
  what HQ's build generates from `put_in_root` and `case_list_form`, with Core's session stack (part
  02); Vellum's question types, its output values and itext (part 03); the name checks of each HQ
  editor and of Core's parser (part 04); the API resources and the views a reading calls (part 05);
  Vellum's reading of a form, model against body (part 06); HQ's basic and advanced case builders,
  its entry builder, its details and its search configuration (part 07); its text interpolation, its
  search query functions and Core's XPath (part 08); its question summary and its form builder's
  save (part 09); its media map and upload (parts 10 and 11). The claims of the research, the
  outline, a manifest cell or a source comment that these reads corrected are recorded in
  [`harness-findings.md`](../../research/2026-09-26-hq-round-trip/harness-findings.md), "Found while
  planning step 6".
- **Reads of Nova's manifest and registers by script**: every entry by disposition, reason kind and
  surface key (part 01; part 14), every `widen` row (part 04), the lane's timings and the store's
  keys (part 14, section 12), and `../nova-plugin` at `0a67203` by claim (part 15, section 9).

Nothing was run in HQ, Core, Formplayer, Android, Connect, a browser or the lane, no production read
was made, and no billed call was sent. Two free local runs settled a fact: a three-line entry bundled
with the form evaluation worker's own options showed that a bundle reaching the archive library needs
a `require` of its own (part 12, "Executed during planning"), and the contract sweeps of part 15's
runs H2 and H5 were run as written at `main`, where every hit is a sentence this plan rewrites or
one of the four it names as standing.

**Written and not yet run.** Each part states its design as the plan's and says in place where a run
is outstanding, with every outcome written out; part 15's section 10 is the stacks' checklist, and
its section 10.3 lists what must have answered before each merge. No heavy run is made on the
person's machine: every lane run, served reader, scale test and native family goes to GitHub's
runners. What runs locally is small and named in the table: the free sweeps and hash runs, A9's
grammar generator (R1, seconds), A5's scan against the local database before it reads production,
and the single billed commands of H1 and E1 on a yes. Three kinds of run need the person's yes,
asked every time, with no standing approval:

- **A read-only production read**, run by the person as their own gcloud identity, content-free,
  its output never committed. There are three: B8's scan for an HQ app two live Nova apps publish to,
  which B8's merge waits on and whose guard the migration repeats; A5's scan for a registration form
  that the one new refusal would meet; and the census at the exit, which orders step 7.
- **A lane run started by hand on GitHub's hosted runners**, asked with its documents, its readers
  and its cost. A dispatch of eleven or twelve bases with every reader is 8 to 31 worker-hours and
  holds up to fourteen of the account's twenty runners for one to three hours (part 14, section
  12.4). The twenty-two bases go in two such dispatches, and `hq-plain` is in both, because a
  dispatch names at least one edited document: `hq-plain` with ten others, then `hq-plain` with the
  remaining eleven. One runs at a time, never beside a scheduled lane with the readers.
- **The two billed schema checks**, H1 at A10's head and E1 at B12's, each one live OpenAI request a
  tool, run only on a yes and never as the bare command. A no leaves that stack unmerged.

| Run | Pull request | Where it runs | Whose yes | Outcomes in brief | In full |
|---|---|---|---|---|---|
| P1, the probe | A1 | the lane with every reader over `hq-plain`, by hand | the person | Nothing; a spelling rule with its proof; an emission gap handed to the stack A pull request that owns it; a first-publish entry; a new not-yet entry in A2 with a variant in B13; a walk taught or stopped. A1 does not merge until a run's gate passes | part 14 |
| P7, A made again | A1 | its own CI | no one | Equal, or the retained app is written after one `wrap` round, or the unit saves through `save_doc` | part 14 |
| Run 1, the `.ccz` mirror | A3 | the lane with the readers over `targeted-kept-values`, by hand | the person | The cells of `KEPT_AT_HQ` stand; a differing profile property, app string, `PostURL` or credentials block is fixed in A3; a key HQ's build writes moves to kept; a difference no row names is put to the kept test | part 01 |
| Run 2, Core's fuzzy match | A3 | its own CI | no one | Every vector agrees, or `lib/preview/listFilterMatch.ts` is corrected | part 01 |
| G1, HQ's build against the local suite | A4, A5 | each one's own CI | no one | Equal, or the emitter is corrected to HQ's bytes in that pull request | part 02 |
| G2, the served readers' walks | A4, A5 | the lane over five documents, by hand | the person | Nothing; a walker is taught; or a landing is corrected, with a `different` reading where the platforms then differ | part 02 |
| G3, the Register return | A5 | its own CI | no one | As planned; or one refusal stops applying to the `always` arm; or one new code and one not-yet entry under `menus`, with one sentence more on the public page in A11 | part 02 |
| G4, case first against the wire | A4 | its own CI | no one | Equal, or `screenChoosesCaseFirst` is corrected. A4 does not merge with the two unequal | part 02 |
| G6, the first menu's shared case | A4 | its own CI | no one | The three shared-case refusals stand, or A4 lands without them and adds one targeted document | part 02 |
| The A5 scan | A5 | locally, then production, read-only | the person | None found: A5 merges and the script leaves. Some found: A5 waits; each app is repaired by its author in the builder or, on the person's yes for that app, by one fenced repair that leaves nothing behind | part 02, section 16; part 15, section 5.3 |
| G5, Android's number keypad | A6 | the lane's Android reader, by hand | the person | Preview's Android rule and the note stand, or take what the read shows; written into A6 before the stack merges | part 03 |
| G1, the form builder keeps a calculated value | A7 | proof 4 in its own CI, and once by hand with the editors | the person, for the run by hand | Nothing; one code and one REFUSED entry, which B6 claims by the rule's own predicate; or a spelling rule with its proof | part 03; part 08 |
| G2, label text read as an instance | A7 | its own CI | no one | The split lands; or it is dropped; or the quote mark is written as a literal output too, or the change is dropped and the label joins the Connect text issue. Finding 76 of `harness-findings.md` is edited in A7 under the second and third | part 03 |
| G3, each runtime prints a value as Preview does | A7 | its own CI | no one | Nothing; Preview's evaluator is corrected to Core's text; or the `count` wrapper is removed, or one code and one REFUSED entry are added, which B6 claims by the rule's own predicate | part 03; part 08 |
| G4, plain help on a device | A8 | the lane's Android reader, by hand | the person | Stands, or `plainHelp` with its switch, input and entry leaves A8 | part 03 |
| R1, the grammar generator | A9 | A9's working tree, seconds | no one | The hashtag segment lands as written, or by one of two written fallbacks in the grammar | part 04 |
| R2, the names' documents | A9 | two lane dispatches, by hand | the person | Each document passes, or the one grammar it holds falls back to not-yet with its owner; five fallbacks correct a bullet of `harness-findings.md` in A9. A9 does not merge until both have run | part 04 |
| H1, stack A's billed check (part 02's G5 inside it) | A10 | the implementer's shell | the person, once | Every request passes and stack A deploys `.a9`; a refused schema is corrected in A10, the literal moves to `.a10` and that one entry is asked again; a no leaves A10 unmerged | part 15 |
| H2, H3, H4: the contract sweep, the docs build, the plugin sweep | A11, A10 | free reads and A11's own CI | no one | Silent; or each hit is fixed in the pull request whose behavior made it false; a plugin sentence stack A makes false gets its own pull request | part 15 |
| H6, stack A's exit | after the merge | `main`, the first night, the deploy | no one | Every row holds and stack B opens; or the failing row is fixed forward and checked again | part 15 |
| G1 to G7, HQ's answers to the reads | B1 | `proof-slice.yml` on B1's branch, by hand, before B1 opens | the person | Each answer is retained and B1 is written for outcome A; four outcomes move one branch of its code; two remove a circumstance code | part 05 |
| R1, a form builder save and generated nodes | B3 | its own CI | no one | Stands; the saved spelling joins as a second accepted tree; or the emitter is corrected against `main` first | part 06 |
| R2, the reader at Nova's ceiling | B3 | `reader-scale.yml`, by hand | the person | At or under 20 seconds, or B3 gains a memo and the run is made again | part 06 |
| G4, the entry facts over the corpus | B4 | its own CI | no one | Equal, or the key joins the fact lists. B4 does not merge with an unequal list | part 07 |
| G2, an excluded Search field no filter reads | B5 | its own CI | no one | As written, or one not-yet entry | part 07 |
| E1 to E4, the spelling, interpolation, CSQL and `current()` vectors | B6 | its own CI, natively | no one | Nothing; a rule narrows; the port or the emitter is corrected; or one change becomes a declared, worker-touching entry | part 08 |
| E5, read-back over the fuzz corpus | B6 | its own CI | no one | Nothing, or a fold, a canonical row or a claim is added. B6 does not merge with one open | part 08 |
| G1, the duplicate-claim scan | B8 | production, read-only | the person | No HQ app has two live Nova apps: B8 merges. Some has: the person chooses which app keeps publishing, the others go to recently deleted, and the scan runs again | part 10; part 15, section 5.3 |
| R1, a replacing upload and an unnamed table | B9 | its own lane run | no one | The test stays as control, or B9 does not merge as written and gains the refusal `managed-table-shares-the-space`, recorded in `harness-findings.md` | part 11 |
| R2, a reference with no file on each platform | B9 | `proof-slice.yml`, by hand | the person | Stands, or the slot the outcome names moves between drawn and inert for that platform | part 11 |
| K1, the canon list is complete | B7 | its own CI | no one | Nothing; a pair joins `CANONICALIZATIONS`; or the owning reader module is corrected first | part 09 |
| K2, HQ's type rows | B7 | `proof-slice.yml` on B7's branch, by hand | the person | The port agrees, or `HQ_TYPE_ROWS` is corrected | part 09 |
| K4, acceptance fits its budget | B7 | `reader-scale.yml`, by hand | the person | At or under 40 seconds; or one reduction; or the largest of 125, 100 and 75 forms that fits becomes the stated ceiling, and where 75 does not fit stack B does not merge and the person is told | part 09 |
| M1, the check fits its memory | B10 | `reader-scale.yml`, by hand | the person | Both checks answer under the worker's heap limits and the server's share stays at or under 512 MiB; or the ceiling comes down K4's ladder to the largest size that fits, the smaller of K4's and M1's standing, and where 75 does not fit stack B does not merge and the person is told; or the server stops holding the application resource once its menus are typed, and the run is made again | part 12 |
| E1, stack B's billed check (part 08's E7 inside it) | B12 | the implementer's shell | the person, once, as B12's first act | Every entry the hash run names passes (`getLookupTables` and `getOrganization` are expected); a refused one is corrected and asked again; a no leaves B12 unmerged | part 13; part 15, section 3 |
| P2, every base with every reader, with part 07's G3, part 08's E6, part 10's G2, part 09's K3 and part 01's Run 3 inside it | B13 | two lane dispatches by hand, `hq-plain` with ten other bases and then with the remaining eleven | the person, each dispatch | Nothing; a reader defect amends the pull request that claims the shape; an emission gap is fixed in B7; a first-publish entry lands in B7 and the person reads its sentence before the merge; a shape is re-cut to not-yet with a variant; a starter app that reads to an account stops the merge | part 14, and each named part |
| G1, a form builder save of Nova's Save to Case shapes | B13 | its own CI | no one | The test stays as control; one canonicalization in B4; or the forms become a variant, recorded in `harness-findings.md` in B13 | part 07 |
| P3, P5, P6, P8: the bundle's bytes, proof 6 over the Nova-born corpus, parity's first run, the media read at the pin | B13 | its own CI | no one | Each green, or the reader, the Python reader or the read is corrected. Stack B does not merge with a `proof6` difference | part 14 |
| P4, the judge's cost | B13 | `ci.yml` with `proof_fresh=true`, by hand | the person | A median `proof6` item under five worker-seconds, or the bundle's `--serve` mode; the timings are committed in B13 | part 14 |
| H3, H4, H5: the docs build, the plugin sweep, the contract sweep | B14, B12 | free reads and B14's own CI | no one | As H2 to H4, for stack B | part 15 |
| H7, stack B's exit | after the merge | `main`, the first night, the deploy | no one | Every row holds and step 6 is done; or the failing row is fixed forward, never by a register entry | part 15 |
| H8, the census | after stack B is live | production, read-only | the person | A group alone keeps an app out: step 7's order follows the count, a tie going to the first column and then to the listed order. No reading holds a not-yet finding, or a no: the listed order stands meanwhile | part 15; part 12, section 8 |

## What changed from the outline, and why

The outline fixed the step's scope. Planning it against the code and the pinned sources changed
these. Each is a decision; the part named gives its evidence. The first twelve are the outline's ten
items, its cutover and its exit, in its order. Items 13 to 26 are the larger changes, and item 27
holds the decisions where an alternative was weighed and not taken and the choice changes what a
person, a publish or the system does. Part 15's section 12 lists every departure from the outline
and the research and every alternative weighed and not taken, one row each.

1. **Item 1, the reader, is one pure function with admission as an accounting.**
   `lib/commcare/reader/index.ts::readHqApp` reads nothing but inputs fetched beforehand, claims every
   key and construct it consumes against a manifest entry, turns everything unclaimed into a finding,
   and reports every finding in one pass. Two of the outline's sentences are not built: an app with
   a translation for a runtime UI key comes in, the keys kept at CommCare HQ's value (part 01,
   Departure 7), and there is no stored `xmlns` slot (item 17 below). Parts 05 to 09.
2. **Item 2, the birth owner, is `hq-adoption`, the fourth caller of the genesis writer.** The
   outline's "third owner" counted two; three production callers exist today. Tables and places are
   written inside the genesis tail through one new seam, `afterAppInsert`, and the media edges, the
   adopted deployment and the claim commit with sequence 1. Media bytes are published before it, as
   ordinary ready rows found by content hash, because Project media cannot commit with an app. The
   identity rows are dense, since every id an HQ app holds differs from Nova's derivation, and the
   table's privilege becomes insert and delete. Parts 12, 10 and 11.
3. **Item 3, project-space data, is a copy managed in CommCare HQ.** The fact lives on the Project's
   table and on the app's organization state, the writers refuse every authoring edit in one place,
   and a publish re-reads each managed table first with the publisher's own key. The ledger gains no
   `referenced` ownership value. Part 11.
4. **Item 4, drift merging, leaves step 6.** It is step 7's first group, `changes-made-in-hq`. A
   merge is the difference of two readings matched by external identity, so it needs the reader, the
   resolver and the read baseline built and proven first. Step 6 keeps the stop, words it by where
   the baseline came from, adds "Stop publishing here" beside "Publish over this", and stores the
   identity map that group reads. Parts 10 and 13; [`7-rest-of-model.md`](7-rest-of-model.md).
5. **Item 5, entry points, are three entries to one flow and six MCP tools.** No builder exists
   before an app does, so the flow is a state of `/build/new`. The platform declaration is a
   preselected choice in the review, never a gate before the app exists. Parts 13 and 12.
6. **Item 6, grammar widenings: all forty-five rows are answered, and nine are built.** A name cannot
   be fixed in CommCare HQ without changing data, so each widen is built or is honestly not-yet:
   nine built, eighteen split into today's grammar plus a not-yet class with its owner, eighteen
   answered by A2, A3 and A5. Names with non-ASCII letters are not built, because each runtime reads
   a name by its own Unicode tables and step 6 has no one pattern to prove. `widen` then leaves the
   manifest's schema. Part 04.
7. **Item 7, feature-matrix apps, are bases, variants and exemptions.** Twenty-two bases made
   through HQ's own pages, models and form builder; variants as patches over a base with an
   `expected.json`; a synthetic layer for entries on `schema:` keys alone; a closed exemption list.
   Coverage is defined, not "one HQ app per manifest entry plus generated combinations". Part 14.
8. **Item 8, what step 3 left.** Every lowering Nova writes reads back as the arm that writes it, the
   lowered date-and-time comparison among them. Where the outline said otherwise: `unwrap-list` is
   read and kept as `list(...)` and never authored anew; device-data search values and `call` in a
   record slot stay not-yet; a date-only comparison on a system date stays not-yet, since no read
   gives Nova the project space's time zone, while HQ's own `today()` reads as Nova's and the first
   publish says the day is now the worker's; `_xpath_query` rows are read conjunct by conjunct into
   slots Nova has, with no new list slot. A calculated value in prose is a stack A concept, and
   label text holding `instance(` is a defect of today's emitter, fixed for every app in A7 once
   part 03's run G2 has shown HQ's build reading it. Under that run's outcome B there is no defect
   and no change; where its outcome C finds no spelling HQ's scan leaves alone, the label joins the
   Connect text issue. Parts 08, 07 and 03.
9. **Item 9, what step 4 left.** The reader returns each declaration the content runs on, with and
   without the date-and-time split, and proposes one; content no choice runs is the circumstance
   `no-platform-runs-everything`, one finding a use. A split question reads back as three ordinary
   questions with no shape of its own. Media is sniffed before any name is trusted and judged by
   platform. The guarded and `current()` reads Nova writes read back by part 08's one recognition
   method, as every expression does. **Bringing an app in asks none of the confirmations a publish
   asks**: the app already runs in its source project space, so Nova records the plan features it
   already uses and leaves the rest to the first publish. Parts 06, 08, 11, 13 and 10.
10. **Item 10, what step 5 left.** Each placement is held at CommCare HQ's real position, compared
    through an extended `publishedCaseBlocks` and the facts HQ's entry builder reads. A Save to Case
    block is held only in Nova's own shape. An advanced menu's chain is built from its forms' loads,
    since HQ's `AdvancedModule` stores no parent selection. A preload reads as a default where the
    load's order allows and is not-yet otherwise. Links read in reverse with their held-case guards
    stripped. The search workflow reads from three booleans, with list first decided by the HQ
    app's own Web Apps setting. Model iteration by the load-time rule is not built. And nothing reads
    a deployment to judge a placement, so ending one decides nothing there. Parts 07, 06, 03, 02
    and 10.
11. **The outline's cutover is not built, because it has no data to move.** A Project table's
    standing in a project space is derived from the live mappings of the Project's apps, so no
    per-app record is merged ("Migrations and the cutover", below). Part 11, Departure 5.
12. **The outline's exit stands as proof can hold it**: every base comes in, republishes and passes
    its proofs; every variant is refused or held as its `expected.json` says; every manifest entry is
    base-exhibited, variant-exhibited or exempt with a reason. Part 14, Departure 7.
13. **One name.** The feature is "Bring in an app from CommCare HQ" and the verb is "bring in", never
    "import", which already names the files Nova sends to CommCare HQ and a CSV that replaces a
    table's rows. In code: the reader, a reading, a finding, the account, the review, adoption.
14. **Six standings, derived and never authored.** `lib/commcare/surface/standing.ts::standingOf`
    gives every entry one of `held`, `kept`, `inert`, `not-yet`, `never` and `fix-in-hq` from its
    disposition and reasons. A not-yet or refused entry names a `subject`, the noun a person reads,
    and a not-yet entry names its `owner`, the step 7 group that will hold it. An item no entry names
    is `unrecognized`: Nova's to classify, worded as Nova's. Part 01, section 2.
15. **The kept test.** A top-level item is kept at CommCare HQ's value only when Nova's publish never
    changes it there, nothing the document holds does something different under its value, and every
    Nova surface that claims to show or run it reads the target's value or states the difference.
    `KEPT_AT_HQ` holds one row for each kept entry with what the `.ccz`, Preview and another project
    space do, bound to the manifest both ways. Everything inside `modules` and every form attachment
    is held, inert or refused, never kept. Part 01, sections 4 to 6.
16. **Concepts come into step 6 as stack A**, each a complete feature (domain, validator, emitter,
    Preview, builder, tools, public docs, platform row, proof): a menu that shows its forms in the
    menu above, registration from the case list always offered, the Phone Number question, a
    calculated value in prose, a search with no title, a sort rule's blanks, text shown as typed, and
    the identifier grammars. Each is something an HQ author makes in an ordinary page. Parts 02, 03
    and 04.
17. **No `Form.xmlns` slot: identity is per adopted deployment.** An adopted app's menu ids, form ids
    and `xmlns` are rows of `app_deployment_identities` for that deployment only, and its media
    paths rows of the sibling table `app_deployment_media_paths`. Every other project space and the
    HQ app file take the derivation, and the review says so. A stored slot would carry one project
    space's identity into every other. Part 10, sections 2 to 4.
18. **One HQ app is published to by one Nova app, and a person can stop.** A partial unique index
    over live, unreleased app mappings holds it across Projects. A deployment can be ended, by
    "Stop publishing here" on the Publishing card and at the drift stop: the HQ app stays as it is,
    this Nova app stops publishing to it, and it can be brought in again as a new Nova app. Part 10,
    sections 5 and 8.
19. **The reading is durable and advances in bounded steps.** One `hq_app_readings` row whose id
    becomes the app's id, advanced by idempotent, request-scoped steps compared by revision: no
    background job, no lease, no lock held across CommCare HQ's answers, and no HQ source at rest.
    Each step has 270 seconds, whoever calls it, which leaves the route 30 of the 300 an MCP call
    is capped at. Inside it the reader and acceptance run in a worker thread the step stops at 60
    seconds and holds to a heap limit of its own, so one large app cannot hold the instance's event
    loop or take its memory: an app past either limit is told it is too large for Nova yet. An
    instance runs one read step at a time. A running step marks its row every ten seconds, and a
    page takes a reading on only where that mark is missing or thirty seconds old. Part 12,
    decisions 9 and 10.
20. **Acceptance runs in production, and a failure of it is Nova's defect.** A reading creates an
    app only when five checks hold: complete accounting; the gate and export readiness with no
    reader-only leniency; the exact fixed point (re-reading Nova's own emission of the document
    gives the document); identity agreement between HQ's source and Nova's emission; and agreement
    with HQ's own question summary. A failure after a clean read is `read-back-differs`, worded as
    Nova's, logged at error with a content-free signature, and the reading stays so it can be checked
    again. Part 09.
21. **Lookup tables and places are managed in CommCare HQ, with no data move.** Only what the app
    reads comes in, as a copy for Preview and validation that Nova never writes where it is managed.
    "Manage in Nova" is the one, confirmed way a person hands a table to Nova. Ownership is derived,
    which also ends today's refusal of a second app publishing the Project's own table. Part 11.
22. **What the first publish changes is a closed register.** Nova writes its own spelling of every
    form; spelling is free and behavior is not. `FIRST_PUBLISH_CHANGES` holds thirty-four entries
    (thirty-five or thirty-six where part 08's run E4 or part 10's run G2 gives its outcome B, each
    adding one), each with a predicate over the reading, the stored-source paths it allows, one
    sentence and whether it touches workers. For each candidate the plan reads the original's
    behavior exactly, refuses it as not-yet, or declares it. The review and the first publish list
    the entries that apply to this app, and the lane holds the predicted set equal to the observed
    set both ways. Part 09, section 11.
23. **Proof 6 and a sixth corpus source.** Apps made in CommCare HQ's own pages join the corpus as
    `hq-authored`, whose A Nova never sent. Proof 6 holds that reading Nova's own export of every
    Nova-born document gives its canonical form, and that a base reads to its document exactly.
    Parity holds the reader's claim log to the lane's Python standings. Part 14.
24. **Bringing CommCare HQ's later changes in is step 7's first group**, planned in full when step 6
    exits, and updating a copy of the app that already lives in a second project space is its last.
    The review and the Publish dialog say plainly what Nova does meanwhile.
25. **Two stacks and two ordinary deploys, where steps 2 to 5 each shipped one stack and one
    cutover.** Stack A is useful with no reader. Stack B's entry point lands at its top and the stack
    merges whole, so nothing needs a flag (part 15, sections 1 and 2).
26. **Versions.** `MODEL_CONTEXT_VERSION` moves in each pull request that changes a served tool or
    the guide: `"v7-hq-round-trip-bring-in.a4"` to `.a9`, then `.b6`, `.b9` and `.b12`. A10 writes
    `.a10` only where its billed check forces a correction. `RUNTIME_VERSION` moves once, to 19, in
    A9, because Preview's query wrapper is renamed (part 04, section 3.4 and Departure 10; part 15,
    decision 3).
27. **Decisions where an alternative was weighed and not taken.** These are the ones that change
    what a person, a publish or the system does. Each is argued at source in the Departure named,
    which states the alternative an implementer could reach for and why it is not built, and part
    15's section 12.1 holds every such row of the plan:
    - A Project table's standing is derived in one snapshot statement, with no lock held from a
      publish's plan to its workbook. The window left open is one request wide and is stated: a
      table handed back to CommCare HQ after the publish's last read and before its upload is
      written once more. Not done: deriving it under the Project state lock held to the upload,
      because no lock spans a CommCare HQ round trip (`lib/deployment/CLAUDE.md`, "No lock spans
      the CommCare HQ round trips"; part 11, Departure 2 and section 10.3).
    - Moving an app to recently deleted writes nothing to the ledger. Its hold on its HQ app is
      released when another app takes that HQ app, and a deleted app holds nothing against anyone
      meanwhile. Not done: releasing the hold in `softDeleteApp` and restoring it in `restoreApp`,
      because the migration runs while the previous revision serves and that revision's delete and
      restore write no ledger column, so the column would be stale from the first minute of the
      deploy (part 10, Departure 1).
    - Three kinds of CommCare HQ media path are not kept: one HQ's own upload cannot address or an
      archive cannot safely hold (no directory, a space at either end, an unsafe segment), one in
      Nova's derived shape that is not that file's own derived path, and one only letter case tells
      from another file's. Such a file takes Nova's path at the first publish, which the register
      declares. Not done: a held path for every path CommCare HQ holds, because each of the three
      breaks a publish or an archive (part 10, Departure 6 and section 4.2).
    - Staged media bytes are kept one day, the bucket's own rule, with no asset row; the verdicts
      are kept for the reading's life, so creating more than a day after the read fetches the files
      again. Not done: keeping the bytes seven days in the pending state, because
      `config/media-bucket-policy.json` deletes `pending/` at one day and changing it is an apply
      outside a deploy; or a pending asset row for a staged file, because nothing reaps a pending
      row (part 11, Departures 1 and 15).
    - The reader and acceptance run in a worker thread, the reading screen names the running step
      alone, and a running step cannot be stopped: a person leaves, or removes the reading from the
      home list. Not done: running them on the request's own thread, because they are synchronous
      work a step gives 60 seconds and one instance serves every other request on the same event
      loop; a ladder of steps with results, because the row holds only the phase, the files' counts
      and a running step's mark of a read in flight; or a "Stop reading" control, because a step
      cannot be cancelled (part 12, Departure 16; part 13, Departures 4 and 5).
    - "Bring it in" is never disabled for a missing answer, and where a person can edit exactly one
      Project it is stated and not asked. Not done: a disabled button, which cannot move focus to
      what is missing, or a question with one answer, which is a gate with nothing behind it (part
      13, Departures 6 and 15).
    - `persistent_menu`, `show_breadcrumbs` and the Android logo slots are kept at CommCare HQ's
      value. Not done: holding them not-yet, because Preview draws neither menu setting, Nova's
      publish writes nothing of a logo, and the `.ccz` states that it cannot carry one (part 01,
      Departures 1 and 2).
    - `READ_CIRCUMSTANCES` closes at thirty-five codes, and a `fix-in-hq` finding carries its
      cause. Not done: a list closed at the twenty codes A2 lands, because each later code is an
      answer none of those words truthfully; or one `fix-in-hq` sentence for each subject, which
      would tell a person that an app CommCare HQ builds cannot be saved or built there (part 01,
      Departures 11 and 12).
    - `#parent` is read and `#host` stays not-yet, since HQ's text names no case type for the step.
      Not done: reading `#host` as one more spelling of a relation Nova holds (part 08, Departure
      12).
    - `GET /api/commcare/connection` is added beside the readings' six routes and the picker's own,
      under the prefix the main host already allows, so "Check connection" no longer goes through
      the Next router in the picker or in the Publish dialog. Not done: a router refresh, which
      writes `/build/new` back over the picker's address, so the picker gives way to the composer
      (part 13, Departure 3).
    - "Stop publishing here" is offered on every Publishing card with a live app. Not done: offering
      it only on a brought-in app's card, because ending is a state of any deployment (part 13,
      Departure 10; part 10, section 8).
    - On an A5 scan that finds an app, and only on the person's yes for that app, one fenced repair
      Job runs once. It is the plan's one exception to "no Job", and on the expected outcome there
      is none ("Migrations and the cutover", below; part 15, section 12.3).

The plan's own pull request, docs and one path inside one source comment, beneath both stacks,
writes this file and its parts, rewrites [`7-rest-of-model.md`](7-rest-of-model.md) around the ten
group ids every not-yet entry's `owner` names, edits [`README.md`](README.md) (step 6 planned in
full, the rule "One name for bringing an app in", why step 6 has no cutover, the baseline), and
writes "Found while planning step 6" into `harness-findings.md`. It also removes the outline, and
changes the one path that named it outside the plan, in a comment of
`lib/agent/authoring/printQueryExpression.ts`, to this file's, so no file links the outline; B6
rewrites that comment whole (part 08, "Contracts"). The three "left to later steps" bullets of the
README point at "What changed from the outline, and why" above (part 15, section 8.1).

## Work items

One item for each pull request, in stack order. Each names what it builds, the decisions that
matter, and the part and sections that plan it in full; part 15's section 1 holds every row with its
files, manifest moves, versions, lane cost and checks.

### Stack A, "What a plain app holds"

- **A1. Lane groundwork and the probe base.** The sixth corpus source `hq-authored`; the package
  `proof/matrix`, which makes a base through CommCare HQ's own views, models and form builder and
  retains it under `proof/hq-apps/<base>/`; the one base `hq-plain` with a hand-written document, an
  edit and five value expectations; the capture's publish over that A with identity overrides; the
  case database seeded from A alone; and `proof/first-publish-changes.json` begun, strict both ways.
  No product code. The probe base is an app HQ's pages make and not a starter app, because every
  starter holds what Nova at A1 cannot. Run P1 hands each emission gap it finds to the stack A pull
  request that owns it, so A1 is settled on its own branch before the stack is cut. Part 14, sections
  2, 3, 4 and 9.
- **A2. Manifest schema and the emission-side re-cuts.** The six derived standings and the derived
  fix cause; `subject` on 587 entries and `owner` on 238; three value classes; the TARGET-OWNED
  schema arm; the re-cuts no code change makes true (`case_tile_field` blank and every tile cell key
  off a custom tile become inert; the ten "outside Predicate" rows are re-worded against the
  checker's rule set); the finding type `{ code, standing, place, subject, detail }`,
  `READ_CIRCUMSTANCES` with twenty codes, and the finding copy, one sentence for each subject and
  standing, held complete both ways by tests (`lib/publish/hqFindings.ts`, `hqFindingCopy.ts`). No
  lane verdict moves. Before A2 opens, its implementer files the issue on a removed language that
  stays in CommCare HQ's build profiles (part 15, section 3, rule 12) and names its number in A2's
  description. Part 01, sections 2, 3, 8 and 9, and Appendix A.
- **A3. Kept at CommCare HQ's value.** Twenty-three entries become TARGET-OWNED;
  `lib/commcare/surface/keptAtHq.ts::KEPT_AT_HQ` holds forty-nine rows with its binding test;
  `TargetFacts` is a pure projection of a deployment's stored baseline source, with no new column and
  no backfill, read by a view-capable reader that never returns the source. The `.ccz` mirrors HQ's
  build of the kept values and states the three things it cannot follow; Preview's list filter folds
  accents and follows the project space's fuzzy search by Core's own rule; the Publishing card lists
  what stays as it is, dated, with **Refresh from CommCare HQ**. It lands its own three public
  pages. Before A3 opens, its implementer files the issue on a filtered tile list's group order
  (part 01, section 6.4) and names its number in A3's description. Part 01, sections 3.6 and 4 to 6.
- **A4. A menu shows its forms in the menu above.** `Module.formsInMenuAbove`; one derived
  projection, `lib/domain/menuScreens.ts`, says which screen lists what, and `screenChoosesCaseFirst`
  replaces the per-module question at every reader; both emitters write what HQ's build writes for
  `put_in_root`. That flag has eleven generated effects, and each is a rule of validation, emission
  or Preview. Such a menu has no screen, so nothing may open it and it takes no search. Nova is
  stricter than HQ's build in three named places, and run G6 may lift one. Part 02, sections 2 to
  9.
- **A5. Registration from the case list, always offered.** The second arm of
  `Module.caseListRegistrationForm`, `{ kind: "always", formUuid, label?, icon?, audioLabel?,
  afterSubmit }`, emitted as `case_list_form` with no synthetic module and HQ's return frames, which
  fire only when the form was opened from the Register action. The arm is narrowed to the shapes
  HQ's build admits and Nova can return from; the wider shapes are not-yet under `menus`. Removing a
  form a list offers is refused, naming each list. One platform row, since Web Apps does not draw
  the action's icon. Its one new refusal, `several-registrations`, can meet a stored app, so its
  scan runs before it merges. Part 02, sections 10 to 16.
- **A6. The Phone Number question.** A typed question display vocabulary
  (`lib/domain/fieldDisplay.ts::FIELD_DISPLAY_SETTINGS`, with the one writer of an XForm control's
  `appearance`, `lib/commcare/xform/appearance.ts::fieldAppearance`) and its first member: a Text
  question with `keypad: "numbers"`. There is no free-text appearance slot and there never will be
  one. Nova adds no validation of its own; the platform row `number-keypad` says what each platform
  does. Part 03, sections 2 and 3.
- **A7. A calculated value in prose.** A sixth prose part kind, `{ kind: "value", expression }`, on
  the five prose slots a form evaluates, with one canonical form, checked by the slot's own profile,
  printed as `<output value>` with its Vellum shadow, protected in translations, and written
  `{{= formula}}` by the Solutions Architect and MCP. With it, literal text CommCare HQ's build would
  read as an instance is split by a literal output so it cannot be, as run G2 holds against HQ's
  build. Before A7 opens, its implementer files the issue on a Connect block's name or description
  holding `instance(` (part 15, section 3, rule 12) and names its number in A7's description. Part
  03, sections 4 and 5.
- **A8. Text and lists.** `searchScreenTitle: { kind: "none" }`, with absent still meaning
  "Search"; a sort rule's `blanks`, stored only where it differs from its direction's own;
  `plainHelp`; `Form.plainText`; and from this pull request Nova writes no formatted copy of a hint
  or a validation message in any app, since no runtime reads one. Part 03, sections 6 to 8.
- **A9. Identifier grammars.** A question id is Vellum's grammar, hyphen included, with three
  derivations made injective; a case type is HQ's editor grammar and no type is refused for being one
  of Nova's reference words, with `#record/<type>/<property>` as the reference text for any type; a
  case write's property takes the catalog's grammar; a select holds one option or more; a choice
  value holds anything but whitespace, unless it holds both kinds of quote mark; a Search field's
  name, a lookup tag and column name and a Connect block id admit hyphens. One migration widens two
  checks, and `RUNTIME_VERSION` becomes 19. Part 04.
- **A10. Agent.** Its own diff is `scripts/test-schema.ts`'s prompts, so each billed request asks
  for a call that uses a new input. Each guide sentence landed with the behavior that makes it true,
  and A10 reads the guide whole. The billed check's list is every Solutions Architect tool whose
  served hash moved between `main` and its head, found by a free hash run; twenty-three are
  expected. Part 15, section 13.
- **A11. Contracts and public docs for stack A.** Nine texts of
  `docs/architecture/complex-apps.md` and ten public pages' sentences. Every subtree `CLAUDE.md` row
  already landed with its behavior. Part 15, sections 6.3, 7.1 and 14.

### Stack B, "Bring in"

- **B1. HQ reads.** `lib/commcare/hq/readJson.ts::readHqJson` tells five failed answers apart; one
  retry rule for a throttled read; one pure classification, `classifyHqFailure`, of every failed
  answer into fourteen kinds, with `hqReadCircumstance` naming part 01's code, which the four
  ladders move onto; `listHqApps`, `probeHqApiAccess` and one reader of the application resource
  (`listAppBuilds` is removed); the bracketed read `readHqAppForReading`, one attempt under a 120
  second deadline that answers `changed` when the app was saved meanwhile; real form ids aligned to
  the source by position; `readHqMediaFile`. Lookup rows are read through `FixtureResource`, the
  resource Nova already calls. Its seven runs are made on its branch before it opens. Part 05.
- **B2. The reader's frame.** The package `lib/commcare/reader/` and `readHqApp`; the manifest at
  run time (`lib/commcare/surface/inventory.ts`); the accounting cursor, where every claim site is
  data held to the manifest by a test; the claim log in the lane's vocabulary; findings and places;
  the application walker; assembly and the declaration choices; and the files later readers call
  (`reader/identity.ts`, `pendingExpressions.ts`, `syntaxCompare.ts`, `hqInterpolation.ts`). A stage
  that has not landed is an unclaimed key, so a half-built reader admits nothing: no stub, no flag.
  The reader has no caller until B10. Part 06, sections 2 to 7 and 16.
- **B3. The reader: forms.** Model and body joined as Vellum joins them; a field's kind decided by
  one table read from the tables the emitter writes with; logic registered as pending text, never
  read here; A's effective load-time order computed; text read by reference and never by id; a
  generated node recognized by rebuilding it with the production emitter; a real attribute and its
  `vellum:` shadow held to one tree; Connect blocks; and the `scale` Vitest project. Part 06,
  sections 8 to 15.
- **B4. The reader: case management, menus and links.** Each rule is the inverse of an emitter, in
  two passes around the expression stage, and every recognition is a proposal the production emitter
  writes back. A form's type is derived from its actions; a preload is a default where the load's
  order allows; a Save to Case block is read only in Nova's own shape; `publishedCaseBlocks` gains
  conditions, links, owners and modes and reports every form it cannot read; `hqEntryFacts` lists
  what HQ's entry builder reads; the hidden registration menu folds back into its host; links read
  in reverse. Part 07, sections 3 to 10.
- **B5. The reader: case lists and search.** A column is read by its format into one of Nova's
  eight kinds; sort through the inverse of `caseListOrderPlan`; the workflow from three booleans by
  the inverse of `searchWireShape`; each conjunct of each `_xpath_query` row is one of six kinds,
  four held on every searching menu and two decided by whether the menu's forms read the search.
  Part 07, sections 11 and 12.
- **B6. The reader: expressions.** One method recognizes everything: bind HQ's text to a candidate
  `Expression`, print it with the production printer, compare two syntax trees under a closed table
  of eight equivalences. No recognizer matches text. Folds are proposals, withdrawn where they do
  not re-emit; expressions are read last, over the whole app at once. HQ's textual interpolation is
  ported as the scanner it is. A record slot is held only where the record dialect can print it and
  read it back. `lib/commcare/emissionRewrites.ts` begins with eight entries. From B6 a plain app
  reads clean. Part 08.
- **B8. Identity and the ledger.** Every entity a reading mints is UUIDv5 under one fixed namespace
  over the app's id and an external key, so every reading of one HQ app gives the same ids. Dense
  identity rows and held media paths for the adopted deployment; the claim; the adopted ledger at
  birth (state `uploaded`, an `adopted` mapping at `pushed_revision` 1, a `read` baseline compared
  as a push baseline is, plan-feature confirmations for what the app already uses);
  `publishAppToHq` keeps the ownership of the mapping it updates; ending a deployment, with a fence
  so a publish belongs to the deployment as it stood when the publish read it; drift copy by
  `DriftReference`; the baseline identity map. One migration. Part 10.
- **B9. Project data.** A file comes in when the read document references it, its bytes sniffed
  before any name is trusted, staged with no asset row, and published as ordinary ready rows before
  the birth; Nova's size limits stand, and over one is a not-yet finding known before creation. A
  reference with no file is judged by slot, kind and platform. Lookup tables and places are copies
  managed in CommCare HQ, with the writer's required purpose refusing an authoring edit in one
  place. A tag that meets a Project table is the same table or one question with two named answers.
  One migration. Part 11.
- **B7. Acceptance and the first-publish register.** The pure `acceptReading` with its five checks
  in order; the typed canon list, sixteen rows, each proven to print equal bytes; the one read-back
  comparison; fifteen more `EMISSION_REWRITES` entries, every behavior-changing site reporting its
  id; `FIRST_PUBLISH_CHANGES` with its sentences and the one renderer `firstPublishLines` every
  surface draws; the list a person reviewed kept on the read baseline. It sits above B8 and B9,
  whose functions it calls. Part 09.
- **B10. The reading and the birth.** `hq_app_readings` in seven states; the read step, the one
  function that makes every verdict, run with no media, again with the media, and a third time
  inside creation; six routes under `/api/commcare/readings`; the review digest, so creation
  re-reads CommCare HQ and creates only where the digest is the one the person sent; the birth in
  one transaction in one stated lock order; a retried creation returns the same app; the census and
  its read-only inspector. A step has 270 seconds for every caller; its check runs in a worker
  under a heap limit, and past its time or its memory the app is `too-large`; an instance runs one
  read step at a time; a running step marks its row, and a page drives only where no step is
  running. Run M1 measures the check's memory at Nova's ceiling. Part 12.
- **B11. The experience.** Three entries, the flow, every screen, the home list's "Coming in from
  CommCare HQ", the Publishing card's additions, the first-publish section of the Publish dialog,
  **Stop publishing here** and the toast that says a restored app's deployment was ended. Two
  routes, `GET /api/commcare/hq-apps` for the picker and `GET /api/commcare/connection` for "Check
  connection", both under the `/api/commcare` prefix the main host already allows, so neither needs
  an allowlist entry. The whole flow is one pure model, tested as state, with no decision in a
  component. Part 13, sections 2 to 13.
- **B12. MCP, the guide and the billed check.** Six tools MCP alone serves (`list_hq_apps`,
  `read_hq_app`, `bring_in_hq_app`, `stop_publishing`, `refresh_managed_data`,
  `set_lookup_table_management`), five changed tools, one guide paragraph, `.b12`.
  `bring_in_hq_app` takes every answer as a required argument and never chooses for the person. The
  plugin's pull request opens beside it. Part 13, sections 14 to 16.
- **B13. Proof at full.** Twenty-one more bases and every variant; the reader bundle run by a judge
  under the image's Node; proof 6; parity; the `source` comparison and the first-publish judge's
  four holds; thirteen HELD-NEW value-class readers in Python; coverage; `proof/corpus/hq/` removed.
  Part 14, sections 5 to 10, 13 and 14.
- **B14. Contracts and public docs for stack B.** The root `CLAUDE.md`; four architecture files
  (`contracts.md`, `complex-apps.md`, `deployment.md`, `multilingual-localization.md`); "proofs 1 to
  6" in this directory's `README.md`; one new public page and eleven pages' sentences. Part 15,
  sections 6.2, 6.4, 7.2 and 15.
- **B15. Removal of this plan.** The plan, its parts and B8's one-off scan leave;
  `scripts/inspect-hq-readings.ts` stays, because it runs again whenever a step 7 group is planned;
  the README reads "Step 6 is done". Part 15, section 16.

## The experience in brief

Part 13 holds every screen, state and string; parts 01, 05, 09, 10, 11 and 12 word the sentences
it draws.

**The flow.** "Bring in an app from CommCare HQ" sits beside "New app", in the empty state, and on
`/build/new`. Each leads to one flow, a state of `/build/new` and never a dialog. The first screen
asks three things at once: the Project to add it to (preselected to the one the person is looking
at), the project space, and the app. A row the person cannot bring in says why in the list. Nova then
reads, showing the step that is running by name and what leaving does: Nova finishes the step in
flight and carries on when they come back. The reading ends in one of three screens. A **stop** says
the read ended and why (no connection, no API access, a linked app, the app changed while Nova read
it), with "Nothing was created, and nothing changed in CommCare HQ". An **account** groups findings by
place in the app's own order, under three labels explained once: "Nova can't hold this yet", "Nova
doesn't bring this in" and "Something to change in CommCare HQ", each group linking to that page in
CommCare HQ, with Copy the list, Check again and Done. A **review** is one screen of what will be
created: the app, where it runs, what stays as it is in CommCare HQ with its date, the tables and
places managed in CommCare HQ, "After it's in", and "What the first publish changes". **Bring it in**
creates the app, which lands on its own home in the builder with one toast that leads to Publishing.
An open reading shows on the home list under "Coming in from CommCare HQ" and can be resumed,
checked again or removed. Over MCP the same service is `list_hq_apps`, `read_hq_app` and
`bring_in_hq_app`.

**The principles.**

- **Every finding in one pass.** A person fixes their list once. Three things can only be judged
  after the rest is clean, and the account says a later check may find more (part 06, Departure 11).
- **Nova's limits are worded as Nova's.** Only what CommCare HQ itself would refuse or break on is
  "Something to change in CommCare HQ". What Nova does not hold yet says so, and what Nova failed to
  classify or to read back takes the blame and is logged at error.
- **No dead end.** Every finding, stop and refusal carries a next step. A table that meets one the
  Project has is two named answers that say what each does to the apps that read it. "Bring it in"
  stays enabled: pressed with a choice unanswered it moves focus there and says what is missing.
- **No "are you sure".** The review has no ticks, the declaration is a preselected choice, and no
  confirmation is asked that the source project space already answers. One question with its
  consequence is asked only where an act cannot be taken back from the same screen: stopping
  publishing, handing a table to Nova, removing a reading.
- **What stays in CommCare HQ is said, and dated.** The kept settings read "as CommCare HQ held them
  on" a date and can be refreshed; a managed table and managed places say who manages them and when
  the copy was last refreshed; what no API returns is stated where it matters.
- **What the first publish changes is said before the app exists** and again in the Publish dialog,
  from the register entries that apply to this app. The reassurance that workers see no change
  shows only where no entry touches workers.

## Proof

Part 14 holds this in full, and part 15's section 1 gives each pull request's proof lines.

- **Both registers stay as they are.** `proof/known-defects.json` stays `[]`, `OPEN_DEFECTS` stays
  `{}`, and no fixed entry leaves its control. An outcome that would add a live entry is settled
  before the merge: fixed, declared in the first-publish register, or taken out of what the reader
  holds as a not-yet entry with its owner and a variant. `proof6`, `parity`, `source` and `changes`
  take no known-defect entry at all; the loader refuses one (section 11.3).
- **A sixth corpus source, `hq-authored`.** A base is authored through HQ's own models and pages,
  retained whole under `proof/hq-apps/<base>/` and held byte for byte to HQ at the pin on every lane
  run. The capture publishes the document over that A with the ledger a bring-in leaves (section 2).
- **Twenty-two bases**: the probe `hq-plain`, a just-created app, that app after one save on each HQ
  page, HQ's three starter apps, and sixteen authored bases, each named with what it exhibits. Every
  kept entry and every entry a first-publish change reads is base-exhibited. Every string in a base
  is invented for the lane (section 6). `template_apps/` holds a fourth directory,
  `wash_before_cond_case_update`, which is no base: by its counts it is `wash` again, and HQ's own
  test of the templates loads the other three (section 6.2).
- **Which proofs run from A to B is one table**: the bar, intent and the manifest check judge A, B
  and the edited B; proof 1 runs against the first-publish register; proof 2 judges every build file
  but a form's XML; proof 3 always walks B, over a case database seeded from A alone with
  hand-written value expectations; proof 4 runs; proof 5 runs where the base states an edit (section
  4).
- **Proof 6, the fixed point.** A judge runs the reader as a bundle under the image's Node. For a
  Nova-born document, reading what HQ serves of it gives its canonical form, under the one closed
  canon list of part 09. For a base, reading A gives its document and reading what HQ serves of that
  document gives it again, exactly (section 5).
- **Variants and coverage.** A variant is a patch over a base's retained answers with the code,
  standing and place it must read to. One test holds every manifest entry to one of three sets or to
  a closed exemption list, and one composed variant holds two refusals to one pass (section 7).
- **Parity** between the reader's claim log and the lane's Python standings, on every use Python
  decides (section 8). **The first-publish judge** holds four things on every base: nothing
  undeclared, nothing declared in vain, behavior only where behavior is declared, and each entry's
  list of bases true (section 9).
- **What these checks cannot hold is stated.** What an expression means, what a list shows and what
  a link does rest on the reader's re-emission comparisons and on proof 3 with value expectations
  (part 09, section 8).
- **The corpus goes from 430 documents to 450 at stack A's head and 473 at stack B's**: one base and
  nineteen targeted documents in stack A (one more under part 02's G6 outcome B), then twenty-one
  bases and two targeted documents.
- **Where the lane runs.** Every pull request of stack A, and B13 to B15, runs the whole lane
  without the readers afresh on every push, because A1 changes the observation's code and B13 its
  records: 14.0 minutes modelled at `main`, 14.4 at stack A's head, 15.5 at stack B's. B1 to B12 run
  the package groups, the judges they change and the documents they emit anew. The served readers
  run by hand on hosted runners at the pull requests the table above names. The first scheduled
  night after each merge is the whole lane with every reader over the merged stack, about 605
  worker-hours after stack A and about 665 after stack B as counted before a measure (section 12).

## The stacks

Two `gh stack` chains, each on the latest `origin/main`, each merged together for one deploy. This
plan's own pull request merges first. Stack A is cut after it; stack B is cut from the `main` that
holds stack A and merges no sooner than the first green scheduled night after stack A is live,
because its pull requests read `main`'s evidence store, which holds no record made under stack A's
keys until that night. That is evidence and no window: nothing is scheduled around it. Part 15's
section 1 gives each pull request's contents and files, and its section 2 the ordering constraints
and why none of the five largest is split.

The rows below are in merge order, from the bottom of each chain up, as part 15's section 1.0
gives it with what each pull request depends on. An id is a name and not a position: B7 sits above
B8 and B9.

| # | Pull request | Parts | Migration | Versions |
|---|---|---|---|---|
| A1 | Add apps made in CommCare HQ to the proof lane as a sixth corpus source, with a probe base | 14 | none | none |
| A2 | Derive every manifest entry's standing, and name a subject and an owner where Nova holds less | 01, 04, 10, 15 | none | none |
| A3 | Keep what stays CommCare HQ's at its value in the archive, in Preview and on the Publishing card | 01 | none | none |
| A4 | Let a menu show its forms in the menu above | 02 | none | `.a4` |
| A5 | Offer a registration form from a case list at any time | 02 | none | `.a5` |
| A6 | Add the Phone Number question as a Text question with a number keypad | 03 | none | `.a6` |
| A7 | Show a calculated value in a question's text | 03 | none | `.a7`; `setFormSections` registered |
| A8 | Hold a search with no title, where blanks sort, and text shown as typed | 03 | none | `.a8` |
| A9 | Widen the identifier grammars to the names CommCare HQ's editors accept | 04 | `20261113000000_hq_round_trip_lookup_names` | `.a9`; `RUNTIME_VERSION` 19 |
| A10 | Make the schema check's prompts use each new tool input | 15 | none | `.a10` only on a forced correction |
| A11 | Document menus, text and names in the architecture reference and the public docs | 15 | none | none |
| B1 | Read an app, its media, its lookup tables and its places from CommCare HQ | 05, 01 | none | none |
| B2 | Add the reader's frame, which accounts for an HQ app against the surface manifest | 06, 01, 08, 10, 12 | none | none |
| B3 | Read an HQ app's forms into questions, text and pending logic | 06, 01, 03, 09 | none | none |
| B4 | Read an HQ app's case management, menus and links | 07, 01, 02 | none | none |
| B5 | Read an HQ app's case lists and search | 07, 02, 03 | none | none |
| B6 | Read an HQ app's expressions by printing a candidate and comparing syntax trees | 08, 06, 07, 11 | none | `.b6` |
| B8 | Record a brought-in app's identity, its hold on its HQ app and the end of a deployment | 10, 01, 09, 14 | `20261201000000_hq_bring_in_ledger` | none |
| B9 | Bring in media, lookup tables and places as copies CommCare HQ manages | 11, 01, 06, 09, 10, 14 | `20261202000000_hq_bring_in_project_data` | `.b9`; `getOrganization` registered |
| B7 | Accept a reading by five checks and declare what its first publish changes | 09, 14, 15 | none | none |
| B10 | Keep a reading of an HQ app as a durable record and create the app from it | 12, 01 | `20261203000000_hq_app_readings` | none |
| B11 | Add the flow that brings an app in from CommCare HQ | 13 | none | none |
| B12 | Serve bringing an app in over MCP and teach the guide about a brought-in app | 13, 01, 08, 09, 10, 11, 12 | none | `.b12` |
| B13 | Prove the reader over apps made in CommCare HQ, with proof 6 and parity | 14, 07 | none | none |
| B14 | Document bringing an app in across the contracts and the public docs | 15 | none | none |
| B15 | Remove the plan for bringing an app in, and its one-off scan | 15 | none | none |

Stack B's order is B1 to B6, B8, B9, B7, B10 and on: acceptance calls the ledger's and project
data's functions, and nothing of B8 or B9 imports B7 (part 09, Departure 14). A title is one sentence
of what the pull request does and names no step, stack or id.

**The rules both stacks keep** are part 15's section 1.3 and its thirteen house rules (section 3).
In brief: every pull request is green at its own head, never only at the stack's; a manifest entry
flips in the pull request whose code first makes its new wording true; a stored-shape change is
optional or a wider grammar; a served-schema change is found by a free hash run and recorded in the
description; `/code-review medium` runs on every pull request and its findings are fixed there; a
stack merges with `gh stack merge <top> --squash`, never pull request by pull request; what CI could
fail is proven green before a push, without loading the person's machine; pushes to the bottom of
stack A and to B13 are batched, since one starts up to eleven whole lanes; after each merge the
deploy is watched on the merge commit from the check-runs listed there; the three defects this plan
found and does not fix are filed as issues before A2, A3 and A7 open, each by its implementer and
named by number in that pull request's description (rule 12), and stack A does not merge without
them filed; and a `../nova-plugin` change rides its own pull request, merged only after its stack's deploy
is live.

## Migrations and the cutover

**Step 6 has no cutover.** It migrates no stored document, takes no maintenance window, writes no
notice, makes no announcement and plans no Job. Part 15's section 5 holds this in full.

Four ledgered migrations ride their stack's ordinary deploy, applied by the deploy's own migration
Job while the previous revision still serves. Each is additive, replays over its own result, grants
nothing (grants converge through `lib/db/privilegeConvergence.ts`), and has a real Postgres test.
Every CHECK, `NOT NULL` and unique index they add was read against the statements the previous
revision runs while it still serves, and admits every row that revision can write (part 15,
section 5.2).

| Migration | Pull request | What it changes | Why it is safe while the previous revision serves |
|---|---|---|---|
| `20261113000000_hq_round_trip_lookup_names` | A9 | Replaces two CHECK constraints on `lookup_tables` and `lookup_columns` with wider, named ones | Every stored name passes the wider checks, and the old revision writes only names both accept |
| `20261201000000_hq_bring_in_ledger` | B8 | The claim (target columns on the mapping row filled by a trigger, the partial unique index, a guard that refuses where two live apps claim one HQ app), `ended` and its count, the `read` baseline origin, the baseline's identity map and first-publish list, and the new table `app_deployment_media_paths` | New columns are nullable or defaulted, the widened checks admit every stored row, and the trigger fills what an older insert leaves out. Statements that need an exclusive lock wait at most five seconds, and a timeout fails the Job with nothing changed |
| `20261202000000_hq_bring_in_project_data` | B9 | Ten nullable columns on `lookup_tables`, eight on `app_organization_state`, `hq_location_id` on `app_locations`, each set with its whole-or-nothing check | Every new column is nullable with no default, so rows the old revision writes pass every new check |
| `20261203000000_hq_app_readings` | B10 | The one new table `hq_app_readings` with its checks, its step mark `step_beat_at` and two indexes | The previous revision never reads the table |

**Why no document migrates.** Every stored slot stack A adds is optional or a wider grammar, and no
stored document holds one: `formsInMenuAbove`, the `always` arm, `keypad`, the prose part `value`,
the `none` arm of `searchScreenTitle`, `blanks`, `plainHelp`, `plainText`, and A9's grammars, each of
which admits every name it admitted before. Stack B adds no document slot at all. So there is no fold
horizon and no transform to write.

**Why no data moves.** The one cutover the research and the outline gave step 6 merged each lookup
table's per-app deployment records into one record for each Project table. Ownership is derived
instead, at preflight, from the live mappings of the Project's apps, so there is no record to merge,
no backfill and no reconcile. Two statements of step 6 write existing rows, both in B8's migration
and both replay-safe, and no other statement of step 6 does: its statement 5 copies two values the
database already holds, a mapping's server and project space, from its deployment row, and its
statement 7 marks as released the mapping of a deleted app that another live mapping duplicates
(part 10, section 11, where the migration is written statement by statement).

**The one way a stored app could be refused, and its scan.** A5's rule `several-registrations` is
the only new refusal that can meet a stored document, and the deploy's runtime probe reruns the gate
over every saved app. So A5 carries a scan, and A5 does not merge while an app holds the shape. The
scan is read-only and content-free (it prints app ids alone), the person is asked first, and it
runs locally and then against production as their identity. CommCare HQ's build refuses that shape,
so none is expected.

**The one conditional repair.** Where the scan does find an app, its author moves the second case
in the builder. Or, on the person's yes for that app, one reviewed repair stops offering the form:
it runs once locally and once in production, through a maintenance image built from A5's head and
the fenced Job runner, with the service serving, and writes one `blueprint-migration` row with its
reason into the app's history. Then the last commit of A5's pull request, made before stack A
merges, removes everything the repair and the scan added: both scripts, the library and its test,
the two bundle lines of the maintenance image, the two allowlist arms of the Job runner with their
tests, and the paragraph of `deployment.md`. The stack merges by squash, so none of it reaches
`main`. That is the plan's one exception to "no Job", and it exists only on that outcome (part 02,
section 16; part 15, section 5.3).

**What a person with an existing Nova app sees change.**

- **After stack A's deploy.** New choices appear where an author meets them: **Show its forms in
  the menu above** on a menu, **Register from this list** on a case list, **Phone number** in the
  question picker with a **Number keypad** switch on every Text question, **Calculated value** in
  the reference picker, **Show a title** on a search, **Blank values** on a sort rule, **Format
  text** on a help text and on a form, and names with hyphens. A Publishing card that has read its
  project space lists what stays as it is in CommCare HQ. Preview's case list filter finds "José"
  for "jose", as a device does, and follows the project space's fuzzy search. An app's next publish
  writes no formatted copy of a hint or a validation message, which no runtime reads, so nothing a
  worker sees changes. An App Test journey in flight is started again under runtime version 19. No
  stored app changes and no notice is written.
- **After stack B's deploy.** "Bring in an app from CommCare HQ" appears in three places. Every
  Publishing card with a live app offers **Stop publishing here** to an admin or owner, and the
  drift stop offers it beside "Publish over this". A second app of a Project publishes the Project's
  own lookup table without being asked to take it over. MCP gains six tools. Restoring an app from
  recently deleted whose CommCare HQ app another Nova app now publishes to brings it back with that
  deployment ended, and a toast says so: "Your app is back, and where it publishes changed". Nothing
  else about an app made in Nova changes: its ids stay derived, its tables stay Nova's to edit, and
  a publish asks what it asks today.
- **Forward only, for both stacks.** Each migration is additive and safe with the previous
  revision serving during its deploy, and a document saved before a deploy loads on either
  revision. Neither stack can be rolled back once it is in use. Stack A adds stored document slots
  and wider grammars (`formsInMenuAbove`, the `always` registration arm, the prose part `value`,
  hyphens in question ids and lookup tags, and the rest) that the revision before it refuses, so
  once an author has saved a document that uses one, that revision cannot load the app. Once
  someone has brought an app in or stopped publishing, the revision before stack B cannot read what
  was written. A bad deploy of either stack is corrected by rolling forward, as with every model
  addition in this repository (part 15, section 5.4).

## Contracts

Part 15's sections 6 to 9 give each sentence as it reads today and its replacement, in the pull
request whose behavior makes it false. A sentence moves with its behavior: every subtree `CLAUDE.md`
row lands in its feature pull request, and the architecture files (`complex-apps.md` in A11 and B14;
`contracts.md`, `deployment.md` and `multilingual-localization.md` in B14) and the public docs land
in A11 and B14, with four recorded exceptions (A3's three public pages and its `contracts.md`
paragraph; A1's and B13's sentences of the root file's `proof/` bullet; B11's `design/readme.md`;
B3's sentence of `docs/testing.md`). In brief:

- **The root `CLAUDE.md`** (B14): the opening gains "An app that already lives in CommCare HQ can
  be brought in and carried on from there."; mental model 3 stops calling `lib/commcare` a one-way
  emission boundary and says a form's `xmlns` and every HQ id are derived except on the project
  space an app was brought in from, where the deployment ledger holds CommCare HQ's own; the
  `lib/commcare`, `lib/deployment`, `lib/lookup`, `lib/db` and builder entries each gain the reader,
  the `ended` state, managed tables, `hq_app_readings` and `components/bring-in` (section 6.2). The
  `proof/` bullet gains apps made in CommCare HQ's own pages and the first-publish register in A1,
  and "proofs 1 to 6, parity with Nova's reader" in B13.
- **`docs/architecture/contracts.md`** (B14, and A3's paragraph "Some of an app stays CommCare
  HQ's."): app birth names four callers of the one genesis writer and says a reading is a record of
  work toward an app and never an app; "HQ deployment safety" gains one HQ app to one Nova app, the
  derived standing of a Project's table, data managed in CommCare HQ never written where it is
  managed, drift measured from the read the app was brought in from, holds recorded by the reading,
  and a bullet that the first publish over a brought-in app changes only what
  `FIRST_PUBLISH_CHANGES` declares (section 6.4).
- **`docs/architecture/complex-apps.md`**: nine texts for stack A in A11 ("Forms in the menu
  above", "Register from the case list", "Question display and text" among them), and in B14 how
  CommCare HQ rewrites a display condition and a filter, the day a search's `today()` names, and a
  new section "Bringing an app in from CommCare HQ", where the binding facts of the whole are read
  once the plan is gone (sections 6.3 and 6.4).
- **Three more files in B14** (section 6.4, and section 1.2's B14 row):
  `docs/architecture/deployment.md` gains one sentence after its runtime probe sentence, that a
  brought-in app is a saved app like any other and a rule that tightens ships its scan first;
  `docs/architecture/multilingual-localization.md` has its one "one-way" sentence rewritten; and
  this directory's `README.md` reads "proofs 1 to 6".
- **Every subtree contract moves with its behavior** (section 6.5): `lib/commcare/CLAUDE.md` in
  sixteen pull requests, with new sections "Reading an app from CommCare HQ", "The reader",
  "Reading case management back", "Reading expressions" and "Rewrites"; `lib/deployment/CLAUDE.md`
  with "One HQ app, one Nova app", "Ending a deployment", "Accepting a reading" and "Readings";
  `lib/lookup/CLAUDE.md` with "Tables from CommCare HQ"; and the files of `lib/commcare/xpath` and
  its `wire`, `lib/domain` and `lib/domain/expression`, `lib/doc`, `lib/preview` and its
  `app-tests`, `lib/db`, `lib/media`, `lib/organization`, `lib/collab`, `lib/export`,
  `lib/agent/authoring`, `lib/routing`, `e2e`, `components` and `components/builder`.
  `lib/agent/CLAUDE.md` is read and does not change. Every place that says "one-way emission
  boundary" is rewritten, two source comments and the Biome rule's message with them.
- **The public docs**, in Nova's voice (section 7): for stack A, a section each for a menu shown in
  the menu above and for registering from the list, and sentences on ten pages; for stack B, one
  new page, `content/docs/bringing-in-from-commcare-hq.mdx`, new sections on tables and places
  managed in CommCare HQ, and sentences on eleven pages. No sentence names a private HQ flag, an HQ
  route or a client's app, and "import" keeps naming only the HQ app file and a CSV.
- **The proof lane's documents** move in A1 and B13, and
  [`harness-findings.md`](../../research/2026-09-26-hq-round-trip/harness-findings.md) gains "Found
  while planning step 6" in this plan's pull request, each gated bullet completed in its run's pull
  request (section 8). Fifteen manifest cells that name a stale fact are corrected with their
  inventory rows (section 8.3).
- **`../nova-plugin`** (read at `0a67203`): stack A changes no sentence a skill states, so it has a
  plugin pull request only where the sweep at A10's head finds one. Stack B's adds the skill
  `/nova:bring_in` and sweeps `upload_to_hq` by claim, takes `plugin.json` from `2.4.2` to `2.5.0`,
  and merges only after stack B's deploy is live (section 9).

## What step 7 is left

[`7-rest-of-model.md`](7-rest-of-model.md) is rewritten in this plan's pull request and keeps its
number. Its first group is new and its last is new; the eight between are cut by what one page of
CommCare HQ writes, so each makes whole apps come in. The manifest is the list: step 6 moves twenty
of today's 237 not-yet entries out and adds sixty-nine, so **step 7 starts from 286 not-yet entries,
each with one owner**. After the first group the order is the census of readings, read by
`scripts/inspect-hq-readings.ts`: the group that alone keeps the most apps out is planned next. The
order below stands wherever the census does not decide (part 15, sections 8.4 and run H8).

| Group | Entries | What step 6 hands it |
|---|---|---|
| `changes-made-in-hq`, first | none | Bringing CommCare HQ's changes in at the drift stop, taking its version where Nova has not changed, drift judged as the difference of two readings, a hint when HQ's copy moved, merging with only a conflict asked of the person; the first production reader of the baseline identity map |
| `project-data-at-hq-size` | 13, and four circumstances | Field properties, multi-valued cells, row attributes, tables that are not global, everything over a lookup cap, media and places over Nova's limits |
| `settings-nova-comes-to-own` | 10 | Non-empty build profiles, case sharing, grid menus, a form's own location capture, generated translation keys Nova cannot fold |
| `question-display` | 64 | Every appearance beyond the number keypad, by the registry and the one writer A6 builds; per-language media |
| `case-list-and-detail` | 62 | Detail tabs, tiles, the remaining column formats, a column the list does not carry, functions in a record slot |
| `menus` | 23 | The wider shapes of registration from the case list, the previous screen for a form on the first menu, a link to a mirror menu |
| `case-search` | 42 | The project space's day in a search, a search value that queries device data, a search on a menu that shows its forms above |
| `forms-and-case-management` | 33 | Stored case selections for an advanced form, the preload order, the tag and index name grammars |
| `xform` | 39 | A Save to Case question at an authored position, model iteration by the load-time rule, a Hidden Value's own bind type, the form rule set's wider vocabulary |
| `second-project-space`, last | none | Updating an existing copy of the app in another project space, which the review and the Publish dialog state meanwhile |

The counts are for every gated run giving the outcome its part plans for, and move by a few where one
gives another (`7-rest-of-model.md`, "The manifest step 7 starts from"). The two outer groups own no
entry and no finding carries either, since a reading meets neither.

## Exit

Each stack's exit is checked by a machine after its merge, from `main`, the first scheduled night and
the deploy's check-runs. None needs a person's judgment. Part 15's section 11 gives each row's check
as a command or a named test.

**Stack A is done when:**

- `proof/known-defects.json` is `[]`, `OPEN_DEFECTS` is `{}`, and no fixed entry left its control.
- Proofs 1 to 5 pass on every Nova export, the twenty new documents among them, and the probe base's
  first publish shows only the differences `proof/first-publish-changes.json` names, in the lane on
  the merge commit and in the first scheduled night with every reader.
- Every new concept is a complete feature: its platform row, its cells and its offering sites are
  held to the gate, and its Playwright spec passes.
- The manifest states a standing for every entry and no widen: every not-yet and refused entry names
  a subject, every not-yet entry an owner, and every kept entry has its `KEPT_AT_HQ` row.
- The deploy is live with its one migration applied, and the runtime probe refused no saved app.
- `MODEL_CONTEXT_VERSION` is `"v7-hq-round-trip-bring-in.a9"` (`.a10` under H1's outcome B),
  `RUNTIME_VERSION` is 19, the billed check passed for every tool it named, and no scan script is
  left.
- The contract sweep prints nothing and the docs build passes.

Stack B is not opened for merge until those hold and that night is green.

**Step 6 is done when every row above still holds, and:**

- No register entry names `proof6`, `parity`, `source` or `changes`.
- Proofs 1 to 6 pass on every corpus document with every reader, and parity holds wherever Python
  decides.
- Every base comes in, republishes and passes its proofs; every variant is refused or held as its
  `expected.json` says; every manifest entry is base-exhibited, variant-exhibited or exempt with a
  reason. This is the outline's exit as it now stands.
- A reading is accepted only when its five checks hold, and creates nothing otherwise.
- The first-publish register is closed both ways: on every base the predicted ids equal the observed
  ones, and every rewrite that changes behavior is declared by a register entry or refused by a
  manifest entry.
- The deploy is live with its three migrations applied, and the guard found no HQ app two live Nova
  apps publish to.
- The readings' routes are reachable on the main host and nowhere else, and both Playwright specs of
  the flow pass.
- `MODEL_CONTEXT_VERSION` is `"v7-hq-round-trip-bring-in.b12"`, `RUNTIME_VERSION` is 19, stack B's
  billed check passed for every entry the hash run named, every served schema compiles, the six new
  tools declare their scopes, and no public surface names a private HQ flag.
- The plan has left: `docs/plans/hq-round-trip/` holds `README.md` and `7-rest-of-model.md`, the
  README reads step 6 done, no file outside the research names the plan or the outline, the one-off
  scan is gone, the census inspector stays, and the `../nova-plugin` pull request is merged.
- The contract sweep prints only the four lines that keep the word "import" for something else, and
  the docs build passes.

Then the census is read, on the person's yes, and step 7's first group is planned in full against
the code as it then stands.
