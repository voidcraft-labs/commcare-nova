# Step 5, part 08: Proving step 5 on the lane

Part of [step 5's plan](../5-case-writes-forms-navigation.md), which holds the baseline, the decisions,
the stack and the exit. This part holds how the proof lane proves step 5: pull request 1, the lane
mechanics (the cheapest edited document's fallback, migration witnesses with scoped identity moves,
the capture's placement record hook, the verdict key for CommCare Supply, a run started by hand that
names a control), and the verdict key for a flag that must be off (pull request 8); every one of the register's 271 entries moved
to `proof/fixed-defects.json` on its retained control, by pull request; the walk stops step 5's
documents meet; the census and how each corpus source adopts the migration's own output; the fuzz
mapping; the edit kinds; the one list of targeted documents step 5 adds; the native proofs and the
reader tests; every manifest flip, value-class reader and gate effect by pull request; what each pull
request costs in CI and what a restack costs; the reader runs started by hand before the merge; and
the first night after it.

Citations are `path::symbol` for Nova at `main` `2f985ed6` (#825) and `file::symbol` for CommCare
at the pins `proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`
(paths under `src/main/java`), commcare-android `7a5584475580`, formplayer `24383ac71bfb`,
commcare-connect `046c7fd78081`, Vellum `01215f251c57` (the build HQ vendors). Stack references use
the sixteen pull requests by number:

| # | Pull request | # | Pull request |
|---|---|---|---|
| 1 | Lane mechanics | 9 | Groups and labels: field lists and plain labels |
| 2 | Attachment mode removed | 10 | Search workflow, menu concepts and claims |
| 3 | Repeats: query placement and whole-number counts | 11 | Form links |
| 4 | Case writes as one concept | 12 | Builder |
| 5 | Held placements and identity moves | 13 | Agent |
| 6 | Publish placements | 14 | Cutover |
| 7 | Advanced modules and extension child cases | 15 | Contracts and public docs |
| 8 | CommTrack and same-type child links at publish | 16 | Removal of the cutover tooling and of this plan |

The stack is cut from a `main` whose nightly reader lanes hold. No production count enters this part.

## Decisions in brief

1. **Every one of the 271 known entries moves to `proof/fixed-defects.json` on its retained control,
   in the pull request that takes its symptom off its document; none is deleted** (§2). The entry
   keeps its id, defect, part, check, artifact, path, kind, values and control and drops `document`
   (`proof/README.md`, "Moving an entry when its defect is fixed"). Deletion is only for an upstream
   change, a deliberate judge change or a lane grant change (`proof/CLAUDE.md`, "The register is
   strict"), and step 5 makes none of the three: no judge stops reporting these classes on controls,
   and `proof/checks/configurations.py::_needs_cloudcare` still grants Web Apps to a control's bodies,
   which carry no `cloudcare_enabled`, so `targeted-list-first-web-apps`'s control keeps HQ's workflow
   selector shown and keeps showing defect 21. At the exit the known register is `[]`, the fixed
   register holds 746 + 271 = 1,017 entries, and `OPEN_DEFECTS` is `{}`.
2. **The moves by pull request**: 2 moves defect 23's 79; 3 defect 25's 101 and defect 30's 4; 4
   defect 28's 3; 7 defect 24's 26; 9 defect 27's 3; 10 defect 21's 37; 11 defect 26's 18 (§2.3).
   Ninety-four of them are served readers' entries, seen to move before the merge only in a run
   started by hand (§8.4) and after it in the first night (§8.5).
3. **No step 5 pull request leaves a live entry** (§2.6). Where a run of step 5 shows a new defect of
   one of step 5's own shapes, the shape is fixed or refused in that pull request; a class that must
   stay visible on the pre-fix bytes is held by a fixed entry on a control retained from the run that
   showed it. The exit's known register is empty whatever an outcome of this plan's runs is.
4. **`_cheapest_edited` reads a control where no known entry of the check names an edited
   document** (§1.1), so the manifest judge's purity test keeps comparing something once the register
   is empty. Lands in pull request 1.
5. **A republish after each migration is observed on a migration witness** (§1.2, §5.2). A witness is
   a targeted document whose state A is the export of the app from before step 5, retained under
   `proof/migrations/<id>/`, and whose B is Nova's republish of the migrated document over it. Eight
   witnesses, one per migration that changes the wire or an identity. Proof 1 compares the old A with
   B and accepts only the identity moves `proof/identity-moves.json` scopes to that witness; the bar,
   the intent and manifest checks and proof 4 judge B; proofs 2, 3 and 5 and configuration
   sensitivity do not run on a witness. A departure from `proof/README.md`, "Identity moves", which
   keeps the file empty by design: a move scoped to its witnesses never accepts its path elsewhere.
6. **Each identity move is written from its witness's own proof 1 evidence**, never by hand, in the
   pull request that lands that migration's emission (G6).
7. **The capture records the placements the first publish writes, and D′ is planned over D with
   them** (§4.5). The hook lands in pull request 1 and records nothing until pull request 6 writes
   `publish-placement`; from pull request 6 `document.json` holds D as stored after its first publish.
8. **The verdict states a CommCare Supply requirement and the flags that must be off**
   (`minimumConfiguration.commtrackEnabled: false`, `minimumConfiguration.flagsOff`), absent where
   Nova's publish asks nothing, read by `corpus.lacking`, `sensitivity.accepts` and `proof5._edit_lacks`
   as step 4's `syncCasesOnFormEntry` is (§1.4). `commtrackEnabled`'s reading lands in pull request 1
   and pull request 8 writes it; `flagsOff` is read and written from pull request 8, the pull request
   whose capability needs it.
9. **A run started by hand may name a control** (`mechanics=control:<id>`), so a moved served entry is
   seen on its control before the merge (§1.5). Lands in pull request 1.
10. **The one list of targeted documents step 5 adds is §5's thirty** (twenty-nine under part 02's
    G4 outcome B, which removes `targeted-worker-underscore-write` in pull request 7): the eight
    witnesses and twenty-two documents of new shapes (twenty-one under that outcome), reconciled from every area's proposals. Every other part uses
    these names. Existing targeted documents whose content changes keep their ids (§5.3).
11. **Fixtures adopt the migration's own output**, source by source, in the pull request that makes
    the old shape inadmissible (§4.2). A corpus document declares what Nova's rule gives its content
    and holds what the migration gives an app like it, so the lane reads what production will hold.
12. **The fuzz sample keeps its draws** (§4.3). Each generator's `lowerToDoc` maps a drawn step 5 shape
    as the cutover maps a stored app, through pure planners kept in `lib/doc`, before
    `lib/doc/platformDeclaration.ts::declaredForContent`, with no new random call. The three
    generators the sample draws gain no new shape: a shape new in step 5 is witnessed by a targeted
    document, and a Vitest oracle corpus that wants to draw one does it through an arbitrary of its own.
13. **Two new mutation kinds get edit-kind generators**: `holdPlacements` (pull request 5) and
    `setFormOtherwise` (pull request 11); and from pull request 5, which lands the kernel rule's
    editor half, the corpus judges a candidate batch by that rule as well as by the commit gate (§4.4).
14. **The walk-stop list keeps its 25 entries unless a run shows otherwise** (§3): `tile-grouped-search`
    and `prompt-widgets` are expected to keep their stops with the same causes after their menus turn
    search first, and `case-operation-link`'s stop is expected to stay.
15. **The manifest flips land with the emission** (§7): each HELD-NEW entry Nova starts to emit flips
    to HELD in the pull request that first emits it, with its inventory row, its platform row and its
    Preview cells where its readings differ; each REFUSED value class on a key Nova newly emits gets
    its reader in `proof/checks/manifest_value_classes.py::VALUE_CLASSES` in that pull request.
16. **Gate effects are written from a whole run** of the pull request that first moves them:
    `toggle/APP_BUILDER_ADVANCED` and `project-space-setting/Domain.commtrack_enabled` in pull request 7,
    the case list menu item's CommTrack effect in pull request 10, `toggle/DONT_INDEX_SAME_CASETYPE`
    in pull request 8 (§7.3).
17. **Native proofs and reader tests land with the change they hold** (§6): six native classes change
    or are added, and four lane tests of HQ's pages, models and a device are added, beside part 03's
    pull request 8 tests.
18. **Every pull request runs the 13.5-minute row**: pull request 1 changes the observation's
    partition (`proof/store/queue.py`), and a stacked pull request reads only main's store, so its row
    is everything between main and its head (§8).
19. **Served readers run on GitHub's runners only, never on the person's machine**, by hand at the
    heads of pull requests 1, 2, 3, 4, 7, 9, 10 and 11 and once at the top of the stack before the merge
    (§8.4). The night after the merge is the whole lane with every reader (§8.5).
20. **The proof area adds no migration class.** It contributes the witnesses, their retained A and
    HQ's reads of it, the scoped moves the notice must name, and the fuzz mapping, which requires the
    cutover's pure planners for defects 21, 22, 27, 28, 29 and 30 to live in `lib/doc` and survive
    the tooling's removal (§4.3).

## 1. Pull request 1, the lane mechanics

Every change here holds over today's corpus: no corpus document is a witness until this pull request
adds the eight, no verdict carries the new keys until pull request 8, and no publish writes a
placement until pull request 6. Pull request 1 changes no byte any existing document emits.

### 1.1 `_cheapest_edited` falls back to a control

Today `proof/checks/test_judge_purity.py::_cheapest_edited(check)` returns the cheapest edited corpus
document a known entry of `check` names and asserts "The corpus holds no edited document the register
names for {check}" where there is none. `proof/checks/test_manifest.py::test_the_judge_gives_records_read_back_where_hq_cannot_be_imported_what_it_gives_them_here`
calls it with `"manifest"`. The known register's `manifest` entries name eight documents at
`2f985ed6`, five of them edited (`case-capture-followup`, `case-extension-multiple`,
`container-live-count-entry`, `container-nested-query`, `container-query-conditional-parent`); pull
requests 2, 3, 4 and 7 move their entries, and the test then fails with no lane check observing
why (a Nova defect of the lane, recorded in `harness-findings.md`, §9.3).

From pull request 1:

```python
def _cheapest_edited(check=None):
    """The cheapest edited corpus document (``proof/timings.json``); with ``check``, the cheapest document a known
    entry of that check names, or, where the known register names none, the cheapest control a fixed entry of it
    names that retains an edit: either way the check's judge gives a difference there, on records read back as on
    records here."""
    estimate = sharding.estimate(sharding.load_timings())
    edited = [document for document in cases.load_corpus().emitted if document.edit is not None]
    if check is None:
        named = edited
    else:
        known = {entry.document for entry in cases.load_register() if entry.check == check}
        named = [document for document in edited if document.id in known]
        if not named:
            fixed = {entry.control for entry in registers.load_fixed_defects() if entry.check == check}
            named = [control for control in corpus.load_controls() if control.id in fixed and control.edit is not None]
    assert named, f"Neither register names an edited document or control for {check}, so the judge compares nothing."
    return min(named, key=lambda document: (estimate(document.group), document.id))
```

The manifest controls that keep an edit include `case-capture-followup` (defect 23's four `manifest`
entries name it from pull request 2) and the fixed register's eleven edited manifest controls of
earlier steps (`case-capture-multiple`, `case-operation-key`, `container-nested-query` among them), so
the fallback has a control from the first day. `sharding.estimate` times a control's group
(`control:<id>`) as it times a document's. Rejected: a targeted document that holds a refused use on
purpose (none can: the gate admits no refused use); dropping the test's last assertion (it is what
makes the test compare something).

### 1.2 Migration witnesses, the lane side

**What a witness is.** A targeted document whose spec carries `migrationWitness: true`
(`proof/targeted/build.ts::TargetedSpec`). Its `document.json` `source` is
`{"kind": "targeted", "rows": [...], "migrationWitness": true}` and its source name
(`proof/corpus/entryWriter.ts::sourceName`) is `targeted-migration:<rows>`.
`proof/checks/corpus.py::Document` gains:

```python
@property
def migration_witness(self):
    """Whether the document is a migration witness: a targeted document whose A is the retained export of the app
    from before a migration (``proof/migrations/<id>/``) and whose B is Nova's republish of the migrated document
    over it."""
    return self.source.startswith("targeted-migration:")
```

**Its retained A.** `proof/migrations/<id>/` holds `configurations.json` and, for each configuration,
`export/<configuration>/create.body`, `create.json`, `content.body`, `content.json`,
`create.ownership.json`, `content.ownership.json`, and the lookup workbook and media upload a sidecar
names. Nothing else: no document, no verdict, no archive. These are inputs of a corpus document, not a
register's control, so the "every control is named" rule does not reach them, and they never live
under `proof/controls/`. `proof/checks/controls.py` gains a mode that writes them from an emitted
corpus:

```bash
python3 -m proof.checks.controls <corpus> <id> --migration-a
```

which copies exactly that set from `<corpus>/<id>/` into `proof/migrations/<id>/` and refuses
(`ControlsError(f"{id} is no migration witness of {corpus}: a witness's A is retained from a document whose
source is targeted-migration. Retain a fixed entry's pre-fix bytes as a control instead.")`) any other
document.

**The corpus writer.** `proof/corpus/inputs.ts::retainedMigrationA(id)` reads those files;
`proof/corpus/entryWriter.ts` copies them into the witness's `export/<configuration>/` beside the
captured `republish`, writes the retained `configurations.json` as the witness's own, and refuses a
witness whose migrated document's verdict does not accept one of them:

```ts
throw new Error(
	`${document.id} is a migration witness whose retained A was published under ${name}, and Nova's publish of the migrated document would refuse that project space (it lacks ${lacking.join(", ")}). A witness republishes over the project space its A was published to; give the migrated document content that project space accepts.`,
);
```

`inputs.json` lists the retained files under the witness's `a` role, so a change to them keys the
witness anew.

**The capture.** `proof/corpus/publish.ts::PublishInput` gains `retainedA?: RetainedPublish`
(`{ create: CapturedImport; content: CapturedImport; workbook?: CapturedUpload; media?: CapturedUpload }`,
the shapes the capture already writes). With it, the capture writes no first publish: the peer
(`proof/corpus/targetPeer.ts`) starts holding what HQ holds after it applies A's retained bodies, as it
does for a first publish it captured; the deployment row is the one Nova's first publish leaves
(reached `uploaded`, its ownership from `content.ownership.json`), with the drift baseline the source
the peer reads back after A; and `publishAppToHq` runs once, over the migrated document, writing
`republish`. That is B. The capture asserts the publish proceeds: a stop over a witness ends the
emission and names the witness and the stop's code, since Nova's own push must never read as a change.

**What judges a witness.** `proof/checks/cases.py::document_params(check)` leaves a witness out of
`proof2`, `proof3`, `proof5` and `sensitivity`; the bar (`proof/checks/bar.py::document_bar`), the
intent check (`proof/checks/intent.py::intent_differences`) and the manifest check
(`proof/checks/manifest_usage.py::manifest_differences`) judge B, its build and its bodies, and D's
local archives where D declares Android, never A; proof 4 (`proof/checks/proof4.py`) is over B as on
every document; proof 1 (`proof/checks/proof1.py::document_identity`) compares A with B and the two
local exports. Proofs 2 and 3 between the old A and B are not compared: their differences are the
migration's decided behavior changes (an attachment that becomes a link, rows that follow the query
live, a list that opens on Search in Web Apps), which the notice names and the cutover's planner
tests hold per class; holding them on the lane would need a third register of intended changes, which
`proof/CLAUDE.md` does not admit. Every migrated shape still runs proofs 2 and 3 between its own first
publish and republish, on the corpus documents of §4.2. `proof/checks/stops.py` reads every walk of a
witness, A's included, as it reads any document's: a stop on the old A is held by an entry naming the
witness, whose reason says the walk is the export from before step 5. The observation is unchanged:
`proof/observe/publish.py` reads `export/<configuration>/create` and `content` and `republish` as it
does for every document.

**Scoped identity moves.** `proof/identity-moves.json` entries gain `documents`:
`{"defect", "entity", "path", "documents"}`, `documents` a non-empty list of witness ids.

- `proof/checks/registers.py`: `MOVE_KEYS = frozenset({"defect", "entity", "path", "documents"})`;
  `IdentityMove` gains `documents: frozenset[str]` and `accepts(self, difference, document)` adds
  `document in self.documents`; `load_identity_moves(path=IDENTITY_MOVES, *, witnesses=None)` refuses
  an entry without `documents`, with an empty list, or with a member that is not a string
  (`f"{path.name} entry {index} names the migration witnesses it holds on as a non-empty list of document
  ids (documents)."`), and, where `witnesses` is given, a member not among them
  (`f"{path.name} entry {index} names {name}, which is no migration witness: a move holds only on a
  witness of its migration, so it never accepts its path on a document exported by the current code
  alone."`); `accepted_moves(differences, moves, document)` passes the document's id to each move.
- `proof/checks/test_proof1_identity.py::test_identity_survives_the_next_publish` calls
  `registers.accepted_moves(found, registers.load_identity_moves(witnesses=...), document.id)` with the
  emitted witnesses' ids.
- `proof/checks/test_corpus.py::test_every_identity_move_names_a_witness_of_the_corpus` holds the file
  against `Corpus.emitted`.

**HQ's reads of each witness's A.** `proof/hq/test_retained_reads.py` gains the migration groups:
for each witness, its A published from `proof/migrations/<id>/` (in pull request 1's first commit,
from the corpus document, which is the same bytes) and the source read Nova's drift read makes
(`app-source`) written to `<output>/hq-reads/<id>/app-source.json` and held to the committed
`proof/hq-reads/<id>/app-source.json` byte for byte. These are HQ's own reads of every pre-step
placement class (§5.2), which part 03's `lib/commcare/hq/publishedCaseBlocks.ts::publishedCaseBlocks`
is proven over (its test and part 09's `placements.test.ts` read every `proof/hq-reads/*/app-source*.json` holding a case block), so they stay after
the cutover tooling leaves, for step 6's import. The module docstring's list gains "the migration
groups: each migration witness's A, published as Nova's first publish before step 5 left it, read
once (`app-source`)". This replaces the cutover's `fixtures/pre-step-hq/` directory ("Departures").

**The tests that hold the layout.** `proof/checks/test_corpus.py::test_every_migration_witness_has_its_retained_a`
(over `Corpus.emitted` and `proof/migrations/`): every directory under `proof/migrations/` is the id of
an emitted witness, every witness has its directory, and each holds `create` and `content` for each
configuration its `configurations.json` names, and nothing beyond §1.2's set. Paired: a tmp directory
with a stray file, a missing `content`, and a witness id with no directory each fail by name.

### 1.3 The capture's placement record hook

`proof/corpus/publish.ts::capturePublish` returns, beside the captured requests, `placements:
readonly Mutation[]`: the `holdPlacements` mutations the first publish's `publish-placement` change
carried (`publishAppToHq`'s result names the change it wrote). In pull request 1 the list is always
empty (`placements: []`), because no publish writes the kind until pull request 6, and nothing applies
it: `proof/corpus/emitCorpus.ts` and `proof/corpus/entryWriter.ts` plan D′ before the first publish's
capture runs, so a record has nothing to reach in pull request 1. Pull request 6 moves the first
publish's capture ahead of edit planning in those two files and applies the record there (§4.5).

### 1.4 The verdict's CommCare Supply key, and its flags-off key from pull request 8

`proof/corpus/publish.ts::NovaPublishVerdict.minimumConfiguration` gains `commtrackEnabled` in pull
request 1 and `flagsOff` in pull request 8, the pull request whose `same-type-child-links` capability
first names a flag that must be off:

```ts
/**
 * Present, and `false`, where Nova's publish asks the person to confirm the
 * project space has CommCare Supply off (`commtrack-off`); absent where it
 * asks nothing, which every retained verdict reads as.
 */
readonly commtrackEnabled?: false;
/**
 * The HQ toggles Nova's publish requires off for this document, sorted
 * (a capability's `featureFlagsOff`); absent where none is.
 */
readonly flagsOff?: readonly string[];
```

`novaPublishVerdict` writes `commtrackEnabled: false` exactly where `requiredConfirmations` (part 03)
holds a `commtrack-off` need, and `flagsOff` from `projectSpaceCompatibilityProbePlan(doc)`'s
capabilities' `featureFlagsOff`; until pull request 8 the predicate behind `commtrackEnabled` does not
exist and the key is never written. `flagsOff` stands under part 03's G3 outcome A and under its
outcome B (the harness still turns the flag on, and the verdict still lists it where the sixth
confirmation kind is needed); under part 03's G4 outcome B it leaves pull request 8 with the
capability, and the verdict carries no `flagsOff`.

`proof/checks/corpus.py::verdict_lacks` reads `commtrackEnabled` from pull request 1:

```python
commtrack = minimum.get("commtrackEnabled", None)
if "commtrackEnabled" in minimum and commtrack is not False:
    raise CorpusLayoutError(
        f"{where} holds commtrackEnabled {commtrack!r}; a verdict requires CommCare Supply off (false) or says"
        " nothing of it."
    )
...
if commtrack is False and configuration.commtrack:
    missing.append("CommCare Supply off")
```

and `flagsOff` from pull request 8:

```python
off = minimum.get("flagsOff", [])
if not isinstance(off, list) or not all(isinstance(flag, str) for flag in off) or ("flagsOff" in minimum and not off):
    raise CorpusLayoutError(f"{where} holds flagsOff {off!r}; a verdict lists the flags it requires off, or says nothing.")
...
missing.extend(f"{flag} off" for flag in sorted(set(off) & set(configuration.flags)))
```

`lacking`'s docstring gains "`CommCare Supply off` when its `commtrackEnabled` is `false` and the
configuration has it on" (pull request 1) and "`<flag> off` for each flag its `flagsOff` names that the
configuration holds" (pull request 8). `proof/checks/sensitivity.py::accepts` and
`proof/checks/proof5.py::_edit_lacks` read the verdict through `verdict_lacks` already, so a flip into
CommCare Supply on, or a flip turning on a listed flag, is refused for such a document and its
differences are held to the gate's effects alone; their docstrings name each key in the pull request
that adds it. `proof/corpus/entryWriter.ts` refuses a document whose
`projectSettings.commtrack` is `true` while D's or D′'s verdict requires it off:

```ts
throw new Error(
	`${document.id} turns CommCare Supply on, and Nova's publish asks the person to confirm it is off for this document, so its configuration is one Nova refuses; a check runs only against a target Nova's publish accepts (decision 19).`,
);
```

The control `targeted-supply-point-read` keeps its retained configuration with CommCare Supply on:
its retained verdict says nothing of the key, so it keeps showing what it shows.

### 1.5 A run started by hand may name a control

Today `proof/store/queue.py` builds a run over documents named by hand (`--documents only:<id>,...`)
from those documents and the controls of the known entries naming them (`_controls_of`), so a fixed
entry's control, which no entry names by document, never runs there, and `registers.held_fixed` holds
it only where its control ran. From pull request 1, `only:` accepts `control:<id>` beside a document
id: the control runs and its fixed entries are held. A name that is no directory of `proof/controls/`
is refused (`f"--documents only:{name} names no control: {CONTROLS / id} does not exist."`); the rule
that one named document carries an edit is unchanged. `.github/workflows/proof-audit.yml`'s
`mechanics` description becomes "Document ids and control:<id> names, comma-separated, one of them an
edited document, to run the lane over with their controls alone, showing its mechanics (untick
nightly); none when empty". `proof/README.md`, "The run started by hand", gains "`mechanics` may name
a control as `control:<id>`, so a fixed entry's class is seen on its control before a merge".

### 1.6 The eight witnesses' pre-step specs

`proof/targeted/documents/migrations.ts` holds the eight specs of §5.2 in today's vocabulary, each
with explicit identities from `targetedUuid` and `migrationWitness: true`, appended to
`proof/targeted/index.ts::TARGETED_DOCUMENTS`. In pull request 1 each witness's D is the pre-step app
itself and no `proof/migrations/<id>/` exists yet, so the capture makes a first publish as for any
document; G1 retains A and HQ's read of it in the pull request's second commit, after which the capture
republishes over the retained A. From then on each later pull request that changes a witness's shape
rewrites its spec to what the migration gives the app (§5.2), and the cutover's planner test (part 09)
holds `planner(pre-step document) = spec` for each.

The pre-step document of each witness is also the cutover's pre-step fixture of the same name,
`scripts/lib/hqRoundTripCaseWrites/__tests__/fixtures/pre-step/<witness id>.json`, written in pull
request 1 from the emitted `document.json`'s stored document. In pull request 1 the cutover's capture
test (`fixtures.capture.test.ts`, part 09) holds each fixture to `main`'s schema and gate and records
the facts `main`'s code derives from it; pull request 2, the first that changes a stored shape,
deletes that test, and from then the fixtures stay under part 09's digest test
(`fixtures.digest.test.ts`) until pull request 16 removes them with the tooling. The witnesses' specs,
their retained A and HQ's reads of it stay after pull request 16.

### 1.7 Tests pull request 1 adds

- `proof/checks/test_judge_purity.py::test_the_cheapest_edited_falls_back_to_a_fixed_entrys_control`
  (pure, a tmp corpus of one edited document and one edited control, tmp registers): with a known
  `manifest` entry on the document it returns the document; with only a fixed one on the control it
  returns the control; with neither it fails naming the check.
- `proof/checks/test_registers.py::test_an_identity_move_holds_only_on_the_witnesses_it_names` (pure,
  tmp registers): a move accepts its difference on a named witness and not on another document; the
  loader refuses a move without `documents`, with `[]`, and naming a document outside `witnesses`;
  an accepted move file loads. Replaces the body of
  `test_proof1_accepts_exactly_the_identity_moves_the_register_names`, which keeps its name and
  gains `documents` in its fixture.
- `proof/checks/test_corpus.py::test_every_migration_witness_has_its_retained_a` and
  `test_every_identity_move_names_a_witness_of_the_corpus` (§1.2).
- `proof/checks/test_sensitivity.py::test_a_verdict_requiring_commcare_supply_off_refuses_the_flip_into_it`
  (pure, tmp verdicts, the key absent accepting the same flip), as step 4's sync tests; pull request 8
  adds `test_a_verdict_requiring_a_flag_off_refuses_the_flip_that_turns_it_on` with `flagsOff`.
- `proof/checks/test_proof5_locality.py::test_d_primes_verdict_requiring_commcare_supply_off_is_read`
  (pure): `_edit_lacks` names "CommCare Supply off" for a configuration with it on.
- `proof/corpus/__tests__/emitCorpus.test.ts`: `it("refuses CommCare Supply on where the verdict asks
  it off, and keeps it on for a document whose verdict says nothing")`.
- `proof/corpus/__tests__/publish.test.ts`: `it("republishes over a retained A, sending an update and
  no create, over the baseline read back after A's bodies")`; and `it("writes commtrackEnabled only
  where Nova's publish requires it")` (in pull request 1 with a stubbed requirement; pull request 8
  replaces the stub with the production predicate and extends the case to `flagsOff`).
- `proof/store/test_queue.py::test_a_run_by_hand_may_name_a_control` (pure, tmp proof dir): `only:`
  with `control:x` queues `control:x` and holds its fixed entries; a missing control is refused.
- `proof/targeted/__tests__/targeted.test.ts`: `it("admits each migration witness and gives it the
  configurations of its retained A")`.

## 2. The registers

### 2.1 State at `2f985ed6` (read)

`proof/known-defects.json` holds 271 entries: defect 21 ×37 (proof 4 37), 23 ×79 (intent 2, manifest 5,
proof 4 72), 24 ×26 (manifest 6, proof 3 19, proof 4 1), 25 ×101 (manifest 2, proof 4 99), 26 ×18
(manifest 3, proof 3 1, proof 4 14), 27 ×3 (manifest 1, proof 4 2), 28 ×3 (manifest 3), 30 ×4 (intent 1,
manifest 3). Ninety-four name a served reader's artifact (21: 6, 23: 10, 24: 8, 25: 61, 26: 9); the pull
request lane holds the other 177. `proof/fixed-defects.json` holds 746; none shares (check, artifact,
path, kind, values, control) with a known entry, so every move clears the fixed register's rules.
`OPEN_DEFECTS = {21: 5, 23: 5, 24: 5, 25: 5, 26: 5, 27: 5, 28: 5, 30: 5}`. `proof/identity-moves.json`
is `[]`. `proof/walk-stops.json` holds 25 entries (13 `document`, 12 `control`). `proof/controls/` holds
108 directories; the known register names 28 of them, 17 by known entries only
(`case-capture-multiple-after-13`, `case-capture-multiple-after-3`, `case-extension-multiple-after-13`,
`case-extension-multiple-repeat-after-13`, `case-extension-query-after-13`,
`case-extension-query-after-59`, `case-extension-registration-after-13`,
`case-extension-repeat-after-13`, `case-extension-repeat-after-59`, `container-live-count-entry`,
`container-query-conditional-after-13`, `expander-form-links-emission-forwards-literal-condition-47c96355-0`,
`targeted-labelled-group-repeat`, `targeted-list-first-places`, `targeted-query-repeat-places`,
`targeted-repeat-count-copy`, `tile-grouped-search`). Each of those becomes frozen
(`proof/checks/controls.py::retain` never retains it again) the moment its first entry moves.

### 2.2 Order constraints the stack keeps

- **Attachment mode leaves (2) before the case-writes model (4) and extension children (7).** Defect 23's
  entries on the `case-extension-*` documents sit at paths under `nova_subcases/nova_subcase_*`; pull
  request 7 moves those blocks, which would re-path every still-live defect 23 entry from fresh evidence
  and need new controls under new names. With 2 first, 4 and 7 find no live defect 23 entry.
- **Query placement (3) before any change to `case-operation-query`'s operation paths** (4 moves field
  writes into operations): its seven defect 25 entries move in 3 with the paths they have.
- **Advanced modules (7) and CommTrack (8) beneath search and menus (10)**, the decisions' order: an
  advanced module's case list menu item beside its forms first exists with `Module.caseListMenuItem`
  in 10, so its manifest flip, its CommCare Supply effect and `targeted-commtrack-advanced` land there
  (§5.1, §7, G4). Pull request 7 emits advanced modules without a menu item beside forms, and pull
  request 8's `commtrackReasons` reads a menu item wherever a module holds one (only a formless one
  before 10), its advanced menu-item arm held by a Vitest witness until 10 (part 03).
- **Search workflow (10) before form links (11)**: defect 21's entry on
  `expander-form-links-emission-forwards-literal-condition-47c96355-0` moves in 10 (G3), and 11 then
  rewrites that document's test, keeping its title so the document keeps its id
  (`proof/corpus/documents.ts`, `expander-${slug(first)}-${shortHash(first)}-${index}`), and moves the
  two defect 26 entries on it.
- **Each pull request moves the live entries its change fixes**, in that pull request, because an
  entry whose symptom left its document fails the gate as `unseen` (`registers.reconcile`), and an entry
  may never name a document the corpus no longer holds (`registers.load_known_defects`).

### 2.3 The moves, by pull request

Each table row is a group of entries with one document and one control; the appendix lists every
id. Every moved entry keeps its control; no new control is retained for a defect in step 5.

**Pull request 2, defect 23 (79; 10 served).** The capture write is a link write; no attachment-mode
spelling is emitted (part 01).

| Document → control | Entries |
|---|---|
| `case-capture-multiple` → `case-capture-multiple-after-13` | 12 proof 4 (`case_blocks`, 2 `editor:vellum`, 3 `form:*`, 3 `source:form:*`, 2 `formplayer`, `trace`) |
| `case-capture-multiple` → `case-capture-multiple-after-3` | 2 intent (`data_dictionary`, `form:*` `/case_updates/*/*`) |
| `case-capture-followup` → same | 4 manifest (`upload-question` under `Form.actions`, `FormActions.update_case`, `UpdateCaseAction.update`, `ConditionalCaseUpdate.question_path`) |
| `case-capture-registration` → `case-capture-followup` | 2 proof 4 (`editor:vellum`, `editor:vellum again`, "Case Property is not allowed.") |
| `case-extension-multiple` → `case-extension-registration-after-13` | 1 manifest (`attachment-in-a-savetocase-block`) |
| `case-extension-multiple`, `-query`, `-registration` → each `-after-13` | 12 proof 4 each |
| `case-extension-multiple-repeat`, `-repeat` → each `-after-13` | 11 proof 4 each |

`OPEN_DEFECTS` drops 23.

**Pull request 3, defects 25 and 30 (105; 61 served).** A query repeat takes its placement (model
iteration in Vellum's own spelling, or the count placement), and a count is a whole number, read
directly where it is one (part 04).

| Document → control | Entries |
|---|---|
| `container-query-conditional` → `container-query-conditional-after-13` | 62 proof 4 ("saved query repeat": 40 `formplayer`, 16 `trace`, 5 `webapps`, 1 `form:*`) |
| `container-nested-query` → same | 27 proof 4 ("rewritten into model iteration": 9 `android`, 6 `trace`, 5 `webapps`, 4 `case_blocks`, `formplayer`, `form:*`, `source:form:*`) and 1 manifest (`model-iteration-nested`) |
| `case-operation-query` → same | 7 proof 4 (`@count` and `@current_index` binds, the `xforms-ready` setvalue, in `form:*`, `source:form:*`, `editor:vellum`) |
| `container-query-conditional-relative` → `container-query-conditional` | 2 proof 4 (`source:form:*` bind nodeset, `editor:vellum` parse warning) |
| `container-query-conditional-parent` → same | 1 manifest (`model-iteration-under-late-relevance`) |
| `targeted-query-repeat-places` → same | 1 proof 4 (`formplayer` `.../output/data/*/@count`) |
| `targeted-repeat-count-copy` → same | 1 intent (`evaluate:submission-nodes-*`, pinned `values`) |
| `container-live-count-entry` → same | 3 manifest (`count-from-non-integer-hidden-value`) |

`OPEN_DEFECTS` drops 25 and 30.

**Pull request 4, defect 28 (3; 0 served).** The writer carries an explicit default reading its case;
the export holds no `case_preload` (part 01). `targeted-load-time-values` → same: 3 manifest
(`load-changes-values` under `Form.actions`, `FormActions.case_preload`, `PreloadAction.preload`).
`OPEN_DEFECTS` drops 28.

**Pull request 7, defect 24 (26; 8 served).** The inert subcase goes; an extension child case is a
create operation with an extension link at the placement defect 24's rule gives it (part 02).

| Document → control | Entries |
|---|---|
| `case-extension-multiple` → `case-extension-registration-after-13` | 6 manifest (`extension` and `subcase-never` under `Form.actions`, `FormActions.subcases`, `OpenSubCaseAction.condition`, `OpenSubCaseAction.relationship`) |
| `case-extension-repeat` → `case-extension-registration-after-13` | 1 proof 4 (`app.json` `/modules/*/forms/*/actions/subcases/*/relationship`) |
| `case-extension-query` → `-after-13` (7), `-after-59` (2) | 9 proof 3 (`case_blocks`, `formplayer@local.ccz`, `trace`) |
| `case-extension-registration` → `-after-13` (2), `-after-59` (1) | 3 proof 3 |
| `case-extension-repeat` → `-after-13` (5), `-after-59` (2) | 7 proof 3 |

`OPEN_DEFECTS` drops 24.

**Pull request 9, defect 27 (3; 0 served).** A group holding a user repeat is built without `fieldList`
(part 04). `targeted-labelled-group-repeat` → same: 1 manifest (`user-repeat-in-a-field-list`), 2 proof 4
("Repeat Count is required." on both Vellum saves). `OPEN_DEFECTS` drops 27.

**Pull request 10, defect 21 (37; 6 served).** No document that declares Web Apps emits list first, so
the Case List save changes nothing (part 05).

| Document → control | Entries |
|---|---|
| `targeted-list-first-web-apps` → same | 27 proof 4 (19 `trace`, 4 `case_blocks`, `app.json` `auto_launch`, `suite.xml` `@auto_launch`, `formplayer`, `webapps`) |
| `targeted-list-first-places` → same | 3 proof 4 (`webapps` `/runs/*` added, `/runs/*/viewport` changed and removed) |
| `case-list-match-none` → same | 1 proof 4 (`trace` `/runs/*/end/no-cases/script-ended`) |
| `case-list-no-details` → `case-operation-query` | 1 proof 4 (`trace` `/runs/*/end/empty-menu/unreplayable`) |
| `targeted-search-related-lookups` → `case-operation-query` | 1 proof 4 (`trace` `/runs/*/trace/*`) |
| `tile-grouped-search` → same | 2 proof 4 (`trace` `.../datum`, `.../step`) |
| `targeted-sync-on-form-entry-web-apps` → `targeted-sync-on-form-entry` | 1 proof 4 (`trace` `.../requests`) |
| `expander-form-links-emission-forwards-literal-condition-47c96355-0` → same | 1 proof 4 (`formplayer` `/runs/*/steps/*/submit/nextScreen/type`), under G3's outcome A |

`OPEN_DEFECTS` drops 21 (under G3's outcome B, in pull request 11).

**Pull request 11, defect 26 (18; 9 served).** Each link runs on its own condition, an otherwise runs
when none does, a link targets only what HQ offers, and a carried case value adds the held-case guard
(part 06).

| Document → control | Entries |
|---|---|
| `targeted-form-links-hidden-and-fallback` → same | 3 manifest (`other-module-target` ×2, `not-offered-under-conditional-link`); 13 proof 4 (`app.json` ×2, `suite.xml`, `trace` ×3, `webapps` ×6, `formplayer`) |
| `expander-form-links-emission-forwards-literal-condition-47c96355-0` → same | 1 proof 3, 1 proof 4 (`android@soft_assert:request:*` `get_case_from_case_update`) |

`OPEN_DEFECTS` drops 26 and becomes `{}`.

### 2.4 `OPEN_DEFECTS` and the registers test

`OPEN_DEFECTS` loses each defect in the pull request that moves its last entry, since
`proof/checks/test_registers.py::test_every_live_defect_is_a_later_steps` fails a defect the map names
with no live entry. From pull request 11 its comment reads "Each defect the known-defect register may
hold, mapped to the later step that owns its fix: steps 2 to 5 fixed every numbered defect and
finding they registered, so an entry of any of them is a regression or a fix left listed. Registering
another defect adds it here with its step." and the map is `{}`. The test's docstring opens "Step 5's
exit: the known-defect register holds no entry of a defect steps 2 to 5 fixed." and its last assertion
becomes `assert all(step > 5 for step in registers.OPEN_DEFECTS.values())` (vacuous at the exit; it fails
a later registration that gives a defect to step 5).

### 2.5 Counts by pull request

| After | Known | Fixed | Walk stops | Controls | `proof/migrations/` | `OPEN_DEFECTS` |
|---|---|---|---|---|---|---|
| `main` | 271 | 746 | 25 | 108 | 0 | 21, 23 to 28, 30 |
| 1, lane mechanics | 271 | 746 | 25 | 108 | 8 | unchanged |
| 2, attachment | 192 | 825 | 25 | 108 | 8 | 21, 24 to 28, 30 |
| 3, repeats | 87 | 930 | 25 | 108 | 8 | 21, 24, 26, 27, 28 |
| 4, case writes | 84 | 933 | 25 | 108 | 8 | 21, 24, 26, 27 |
| 5, 6 | 84 | 933 | 25 | 108 | 8 | unchanged |
| 7, advanced | 58 | 959 | 25 | 108 | 8 | 21, 26, 27 |
| 8 | 58 | 959 | 25 | 108 | 8 | unchanged |
| 9, groups and labels | 55 | 962 | 25 | 108 | 8 | 21, 26 |
| 10, search (G3 outcome A) | 18 | 999 | 25 (G3, G2 may add) | 108 | 8 | 26 |
| 10, search (G3 outcome B) | 19 | 998 | as above | 108 | 8 | 21, 26 |
| 11, form links | 0 | 1,017 | 25 (or as G2, G3 leave it) | 108 | 8 | `{}` |
| step 5's exit | 0 | 1,017 | as 11 | 108 | 8 | `{}` |

The fixed register reaches 1,017 under every outcome of the runs §2.6 names: an outcome that adds a
fixed entry adds it beside these, and the exit then states 1,017 plus those, with the control each
retained (§2.6).

### 2.6 No step 5 pull request leaves a live entry

Several areas' runs have an outcome in which a reader or an editor treats one of step 5's own shapes
differently from what the plan expects: a form builder save that rewrites the explicit preload
(part 01's G4 outcome B), HQ's form settings save that changes a link shape (part 06's G3 outcome B), a
Case List save that changes a workflow (part 05's G3 outcome B), a reader that shows a class on a
document after its fix (G2 outcome B here). In every one the same rule applies, in the pull request
whose run shows it:

1. The emitter writes what the reader keeps (an equal spelling), or the gate refuses the shape (its
   manifest entry becomes REFUSED, reason `not-hq-editable`, with the refusal the owning part writes),
   so no admitted document holds the symptom.
2. Where the pre-fix bytes must keep showing the class, the document is retained as a control from
   that pull request's own first run (`python3 -m proof.checks.controls <corpus> <id> <checks> --as
   <id>-step5`), and the class is registered directly in `proof/fixed-defects.json` on that control
   with a new harness finding's number (`harness-findings.md`, after the last), as step 4 retained
   `targeted-list-first-web-apps-declared`.
3. No entry is added to `proof/known-defects.json`, and `OPEN_DEFECTS` gains nothing.

So the exit's known register is empty whatever an outcome is. The owning parts' runs keep their
outcomes; this rule is how each lands on the registers.

## 3. Walk stops

Stops whose documents step 5 changes:

| Stop | Today | From step 5 | Decided by |
|---|---|---|---|
| `tile-grouped-search`, `webapps` and `preview`, `case-not-listed` | list first; grouped tiles drawn as one tile | search first (pull request 10): the client opens the Search screen, then the results from `search_short`, a copy of the case short detail (`corehq/apps/app_manager/models/modules.py::ModuleDetailsMixin.get_details`) whose grouping is the same; the stop is expected to stay with the same cause | G2 |
| `prompt-widgets`, `formplayer`, `search-refused` | list first, Web Apps only, a required prompt | search first: the Search screen opens first with its required prompt blank, and the run that leaves it as it opens is kept back by the client (`corehq/apps/cloudcare/static/cloudcare/js/formplayer/menus/views/query.js`); expected to stay | G2 |
| `fuzz-suite-20260930-8`, `formplayer`, `search-refused` | inline search first | `formsReadSearch: true` under the rename (defect 29); no wire byte moves | unchanged |
| `case-operation-link`, `formplayer`, `submit-refused:the-case-id-attribute-of-a-case-wasn-t-set` | an update linking to a field answer that names no case of the type, so the guard's blank id refuses the submission | expected unchanged: pull request 4 moves no operation of the document and keeps the guard (part 01) | pull request 4's run by hand (§8.4): where the stop leaves its document, its entry becomes a `control` entry on `proof/controls/case-operation-link/` with the reason "The control retains the document from before step 5, whose update links to an answer that names no case: Core's case parser refuses the guard's blank id (defect 22)." |

No other stop's document holds a step 5 shape. A document whose searching menu turns search first and
whose search holds a required prompt is the `search-refused` shape on Formplayer's walk; each such stop
G2 shows is added in pull request 10 with the `prompt-widgets` reason's wording for that document. A
self-link ("start this form again") is followed once by Formplayer's walk, whose script bounds it, and
the run ends at the restarted form's submit; a walk that reaches `WalkBound` there is a walk defect
fixed in pull request 11, never an entry. A Web Apps walk that ends at the first destination of several
(part 06's D2) ends at a screen the worker uses: the walk's end, not a stop.

## 4. The corpus

### 4.1 The census at `2f985ed6`

Read in memory from the corpus's own checked-in sources (`proof/corpus/producers.ts::producerDocuments`,
`proof/targeted/index.ts::targetedDocuments`, `proof/corpus/workforce.ts::workforceDocuments`: 228
documents, 158 producer, 64 targeted and 6 workforce) with the domain's readers, writing nothing. The
expander documents and the fuzz sample are Vitest writers, read from their sources and generators.

- **Field case writes** (`Field.caseWrite`): 79 documents. Attachment mode: 11
  (`case-capture-{registration,followup,repeat,query}` and `case-extension-{registration,followup,repeat,query}`
  on both, `case-capture-multiple`, `case-extension-{multiple,multiple-repeat}` on Web Apps). Link mode:
  the five `case-capture-*` (`scan`).
- **Case operations**: 28 documents (the `case-operation-*` family, `arithmetic`,
  `case-choice-attendance`, `container-live-count-effects`, `location-*`, `lookup-app`, `lookup-reversed`,
  `relation-instance-*`, `targeted-save-to-case-read`, two workforce). Child links: 9. No operation
  carries an extension link: every extension child is a field write to a type declared
  `relationship: "extension"`, the six `case-extension-*`.
- **Close conditions**: `targeted-close-conditions` (4 forms), `targeted-close-condition-unparsable`;
  none on a registration form.
- **Query repeats**: 20 documents. Nested in a repeat: `container-nested-query`,
  `container-init-{named,raw,add,relevance-add}`, `container-section-entry`. Under an ancestor's
  relevance: `container-query-conditional-parent`, `targeted-query-repeat-places`. Query reading a
  form answer: the nested six but `container-init-raw`, plus `container-init-relevance`.
- **Count repeats**: 18 documents: literal counts (8), a field term (7; `container-hidden-count` and
  `targeted-repeat-count-copy` read a Hidden Value), an arithmetic expression (`container-expression`,
  `container-nested-count`, the live-count documents' `computed`), an `if` (`container-init-named`,
  `container-init-raw`).
- **Form links**: 17 documents; conditional links in 9; a terminal unconditional link after a
  conditional one in `form-link-else` and `form-link-overlap`; manual datums in `form-link-manual`,
  `search-hidden-link`, `targeted-form-link-session-reads`; a link to a child menu in
  `targeted-form-links-hidden-and-fallback` only; no self-link.
- **Labelled groups and sections**: 29 documents; a user repeat inside a labelled group or section
  in `targeted-labelled-group-repeat` only; no unlabelled group.
- **Searches**: list first in 34 documents, 26 declaring both and 8 Web Apps only, none Android only;
  search first (today's inline `searchFirst`) in 20 documents, all Web Apps only.
- **No-matches registration forms** (`Form.entry.kind: "search-no-matches"`): 8 documents.
- **Case-list-only menus** (`Module.caseListOnly`): 38 documents.
- **The fuzz generators** (`lib/commcare/__tests__/xformDocArbitrary.ts::blueprintDocArbitrary`,
  `suiteDocArbitrary.ts::suiteDocArbitrary`, `expressionDocArbitrary.ts::expressionDocArbitrary`):
  field writes to the module's own type and to a child type, query and count repeats
  (`SAFE_COUNT_XPATH`: `"3"`, `"1 + 2"`, `"int(3)"`), labelled groups that may hold any repeat, sections,
  `searchFirst` drawn as a boolean, and counts drawn by the expression generator in the
  `repeat_count` slot. No generator draws an attachment-mode write, an extension child, a form link, a
  `postSubmit`, a close condition or a case-list-only menu.

### 4.2 Fixtures adopt the migration's own output, by pull request

`proof/corpus/emitCorpus.ts::admittedDoc` refuses an emission by name where the gate refuses a
document, so each mapping lands in the pull request that makes the old shape inadmissible.

| PR | Shape | Sources and what each writes |
|---|---|---|
| 2 | attachment-mode capture writes (11 documents) | `lib/commcare/__tests__/caseCaptureFixture.ts`, `extensionCaseFixture.ts`: link writes, the class C5 (part 01) gives; the attachment target the corpus passes for link writes is kept |
| 3 | counts that are not whole numbers | `lib/preview/engine/__tests__/fixtures/sectionEntry.ts::liveCountEntryDoc` writes `int(#form/second/items/size + 0.7)` for `container-live-count-entry`'s `computed` count, the class Q2 rewrite, which takes defect 30's manifest classes off it; every other count source whose count the checker no longer admits (`REPEAT_COUNT_TYPE`, reason `whole-number-count`) writes `int(…)` around it, as Q2 does; a count from a Hidden Value calculating an integer (`targeted-repeat-count-copy`, `container-hidden-count`) is unchanged in the document and loses its `nova_count_` node in emission |
| 3 | query repeats (20) | no source change: an absent placement takes the rule's placement at every export (part 04, Q-QR-1): count for the nested six, the two under relevance and the answer readers; model iteration for the rest |
| 4 | field writes (79), implicit preloads, close conditions | every source that writes `caseWrite` writes its operations as C1 to C4 give them (the own arm, a child create per bucket, the worker-record update, the capture link write), through `lib/doc/fieldWriteOperations.ts::operationsFromFieldWrites`; an extension bucket's create takes the Save to Case placement `{save-to-case, [nova_subcases, nova_subcase_<n>]}` its block has today through pull requests 4 to 6 (part 02 §14.4, part 01's placement table), so the six `case-extension-*` documents keep their bytes until pull request 7; each own-case writer of a case-loading form carries the explicit default C7 gives, so emitted bytes stay except on `targeted-load-time-values` (rewritten, §5.3); `targeted-close-conditions` and `targeted-close-condition-unparsable` hold their conditions as C6 writes them |
| 7 | extension child writes (6) | `extensionCaseFixture.ts`: a create operation with an extension link at the placement M1 gives a new document; `case-extension-registration`'s link carrying the new case into a form of its type places it as an advanced open action, so that document's module is the corpus's first advanced module made by its own content |
| 9 | labelled groups (29 documents) | each source writes `fieldList: true` on each labelled group it builds, but a group holding a user repeat at any depth (`targeted-labelled-group-repeat`'s `household`), as Q4 gives |
| 10 | list first (34), today's `searchFirst` (20), derived skip to results, no-matches forms (8), case-list-only menus (38) | each source writes what part 05's `lib/doc/searchWorkflowPlan.ts::authoredSearchWorkflow` (M1) gives its module: a search with no stored workflow reads search first, so a list-first source that declares Web Apps and has a visible input needs no edit and takes M1's output by default, while one with no visible input writes `workflow: "skipToResults"` (M1's last row); a list-first source that declares Android only writes `workflow: "listFirst"`; `searchFirst: true` becomes `formsReadSearch: true` (with `workflow: "skipToResults"` where no input is visible); a search today's `searchWireShape` derives as skip to results writes `workflow: "skipToResults"`; `entry: search-no-matches` becomes the host's `caseListRegistrationForm`; `caseListOnly` becomes `caseListMenuItem` (M2, M5). Sources: `caseListEmissionFixture.ts`, `csqlFunctionFixture.ts`, the localization wire fixture, `compilerNavigationFixture.ts` (`temporalSearchFixture`, `navigation-search-legacy`), `searchPromptFixture.ts`, `csqlQuoteFixture.ts`, `searchEmissionFixture.ts`, `csqlStaticQuoteFixture.ts`, `noMatchesWireFixture.ts`, `nestedMenuWireFixture.ts`, the tile fixture (`grouped-search`), `expander.test.ts`, and the targeted specs `searchApps.ts`, `datetimeEquality.ts`, `csqlComposition.ts`, `sessionContextReads.ts`, `inlineSearchReads.ts`, `noMatchesReturnIdentity.ts`; the workforce documents follow their bases. Rejected: declaring the 26 both-declared list-first documents Android only (it would take 26 Web Apps witnesses of prompts, CSQL and lists out of the client's replay) |
| 11 | form links (17) | L1 to L6 (part 06's `mapFormLinkSemantics`, committed as source): each link's own condition holds the guard, a terminal unconditional link after a conditional one becomes the otherwise (`form-link-else`, `form-link-overlap`), a stored `postSubmit` beside conditional links becomes the otherwise destination (`form-link-module`, `form-link-previous`), `form-link-manual` holds the guarded literal, `formLinksHiddenFallback.ts`, `instanceReads.ts` and `inlineSearchReads.ts` are rewritten (§5.3), and `expander.test.ts`'s "forwards literal condition + datum overrides" takes the migrated shape and keeps its title. `lib/commcare/__tests__/formLinkWireFixture.ts` keeps its scenario ids, so the producer documents `form-link-<scenario>` keep theirs, and gains three scenarios (part 06): `this-form`, `chain` and `carried-held`, three new producer documents |

Pull request 6 changes no source: the capture's record moves `document.json` of every document whose
first publish records a placement (§4.5). Pull request 5 changes no source: before pull request 6
records one, a corpus document holds a placement only where its spec writes it, which is
`targeted-held-placement` (§5.1) and the witnesses (§5.2).

### 4.3 The fuzz mapping

`proof/CLAUDE.md`, "An existing fuzz sample keeps its draws". Each generator's `lowerToDoc` maps every
drawn step 5 shape as the cutover maps a stored app, then calls
`lib/doc/platformDeclaration.ts::declaredForContent` as today. `expressionDocArbitrary.ts` draws
`suiteDocArbitrary` and is mapped by it, and maps its own drawn `repeat_count` slot through item 6.
Each mapping runs inside the existing `docGenSpecArb.map(lowerToDoc)`, so no `fc` call is added. The
mappings, in order, each landing with the pull request that makes the drawn shape inadmissible:

1. **Defect 30 (pull request 3).** A drawn count the checker does not admit as a whole number is wrapped
   in `int(…)` (part 04's `lib/doc/repeatCountWraps.ts::planRepeatCountWraps`, the Q2 rule). Today's
   draws (`"3"`, `"1 + 2"`, `"int(3)"` and the expression generator's `int(abs(…))`) are all typed
   `int`, so it wraps none of them, and it holds any later draw to the rule.
2. **Defect 22 (pull request 4).** The drawn field writes (`case_name` and `saved_prop` on the
   module's type, the child bucket's writes) are built as the operations C1 to C3 give them, through
   `lib/doc/fieldWriteOperations.ts::operationsFromFieldWrites`, whose operation UUIDs are UUIDv5 under
   the cutover's namespace (`lib/domain/caseWriteOperationIdentity.ts`, part 09), so the mapping draws
   nothing.
3. **Defect 28 (pull request 4).** Each own-case writer of a drawn case-loading form takes the explicit
   default C7 writes (`lib/doc/explicitPreloads.ts::planExplicitPreloads`).
4. **Defect 25 (pull request 3).** Nothing: a drawn query repeat holds no placement, and the rule gives it
   one at every export.
5. **Defect 27 (pull request 9).** Each drawn labelled group takes `fieldList: true` unless it holds a
   user repeat at any depth (part 04's `lib/doc/groupFieldLists.ts::planGroupFieldLists`, the Q4 rule,
   with the frozen label predicate the cutover passes).
6. **Defects 21 and 29 (pull request 10).** A drawn `searchFirst: true` becomes `formsReadSearch: true`
   (with `workflow: "skipToResults"` where no input is visible); a drawn search without it writes
   `workflow: "skipToResults"` where no input is visible (whether today's `searchWireShape` derives
   skip to results or lists first, M1's third and last rows), and no workflow otherwise (search first,
   since every draw declares nothing, which is both, so the migration's "the declaration includes Web
   Apps" holds), through part 05's `lib/doc/searchWorkflowPlan.ts::authoredSearchWorkflow` with
   `declaresWebApps: true`. This also
   removes the only way a draw could hold inline search and list first in two modules, which
   `declaredForContent` would refuse as `runs-on-neither`.

Defects 23, 24 and 26 need no mapping: no generator draws an attachment-mode write, an extension child or
a form link (§4.1).

Each planner is pure, deterministic, idempotent and kept in `lib/doc` past pull request 16, as step 4
kept `lib/doc/platformDeclaration.ts`, because the generators call it on every draw; each is named here
as its owner names it (parts 01, 04 and 05, and part 09, which calls the same five). Where the schema
changed (field writes, preloads, the search workflow) a planner takes the facts a draw holds in the old
shape, since a drawn spec cannot build a document in the old schema; where only the gate's verdict
changed (counts, field lists) it takes the document built before the gate. The cutover's transform
calls the same planner over each stored app's facts.

The generators draw no new shape. A shape new in step 5 (an advanced module, an otherwise, a self-link,
a held placement, `plainLabel`, an authored list first) is witnessed by the targeted documents of §5;
the Vitest oracle corpora (`xformOracle.fuzz.test.ts`, `suiteOracle.fuzz.test.ts`) that draw one do it
through an arbitrary of their own that the proof sample does not use (part 02 and part 06 own those).
Rejected: changing what the three generators draw (moves every later draw and the content of every fuzz
document, losing the frozen comparison); mapping in `proof/corpus/fuzzSample.ts::afterDraw` only (the
generators' own consumers, `compilerEvidence.ts::checkCompilerEvidence` and `xformOracle.fuzz.test.ts`,
draw the same arbitraries and require admission).

Test: `proof/corpus/__tests__/fuzzSample.test.ts` gains, in pull request 3, `it("maps each step 5 shape
of a draw as the cutover maps a stored app, with no further draw")`, extended by pull requests 4, 9 and
10: at seed 20260930, size 24, no document holds a non-integer count, a field `caseWrite`, an implicit
preload, a labelled group holding a user repeat with `fieldList`, a list-first search where Web Apps is
declared, or `searchFirst`; and the prefix property (`draw(2)` equals the first two of a larger draw)
holds.

### 4.4 Edit kinds

`proof/corpus/editKinds.ts::EDIT_KIND_GENERATORS` is typed over every `Mutation["kind"]`, and the
lane's emission stops (`proof/corpus/emitCorpus.ts::UnlandedKindsError`) when a kind lands on no fixed
document, a targeted document's written edit counting as one.

- **`holdPlacements` (pull request 5).** `holdPlacements: hosted(HELD_PLACEMENT_HOST, holdPlacements)`:
  on a document whose D holds a placement, an edit that makes one held placement unable to express its
  target (a write the held basic slot cannot hold: a computed value, a write in a repeat), planned
  through `lib/doc/identityMoves.ts::withIdentityMoves`, so the batch carries the move an editor's
  batch carries. In pull request 5 the only edited document whose D holds placements is
  `targeted-held-placement` (the witnesses hold theirs and carry no edit), and its written D′ is that
  edit, so the kind lands; from pull request 6 every document whose first publish records a placement
  is a host.
- **`setFormOtherwise` (pull request 11).** `setFormOtherwise: hosted(FORM_HOST, setFormOtherwise)`:
  on a form holding a conditional link, `lib/doc/formLinkMutations.ts::planSetOtherwise` to the first
  destination `otherwiseDestinationsOffered` gives; on a form with none, the batch first adds a
  conditional link to another form of the menu through `addFormLink`'s planner.
- **The kernel's rule (pull request 5).** Pull request 5 lands the rule's editor half (part 03's
  `lib/db/placementAuthority.ts::placementChangeRefusal`, with the undo arm that admits restoring the
  hold the latest recording wrote), and `proof/corpus/editBatches.ts::judgeProposal` refuses a
  candidate the rule refuses for an `autosave` batch from D to D′, beside the commit gate and the
  publish check, so every corpus edit is one an editor can commit. D's own holds stand as the latest
  recording: the spec writes them in pull request 5, and from pull request 6 the capture's record
  does (§4.5).
- The form-link kinds call the planners as part 06 gives them (`planSetFallback` becomes
  `planSetOtherwise`; a kind that made an else link makes an otherwise), and
  `proof/corpus/footprint.ts` counts an otherwise link as a link of its form.

`proof/corpus/__tests__/editBatches.test.ts` gains `it("moves a held placement as an editor's batch
moves it, and refuses one that records a hold")` (pull request 5) and `it("sets an otherwise only on a
form with a conditional link")` (pull request 11).

### 4.5 The capture records the first publish's placements (pull request 6)

From pull request 6, `capturePublish` returns the `holdPlacements` mutations of the
`publish-placement` change the first publish (state A) wrote. Pull request 6 moves the first publish's
capture ahead of edit planning in `proof/corpus/emitCorpus.ts` and `proof/corpus/entryWriter.ts`
(through pull request 5 both plan D′ first and capture after), and applies the record to D through the
reducer before the edit batch is planned (`proof/corpus/editBatches.ts`), so D′ is planned over the
holds:

- `document.json` holds D as stored after its first publish, with its placements;
- `edit/document.json` is D with its placements plus the batch, as an editor edits a published app;
- the republish B of D is a publish over held placements, which every later publish is.

Pull request 6 moves the key of every document with a case operation, a form's own close or a query
repeat (most of the corpus's case documents), and it can move which candidate the balanced edit
assignment keeps on unrelated documents. Test: `proof/corpus/__tests__/publish.test.ts` gains
`it("records each operation's placement at the first publish and changes no byte of the update it sends
again")`: for a document with a basic placement and a Save to Case one, the first publish's `content`
body and the republish body of D with its placements are equal byte for byte, and the record names
each operation's placement. Rejected: leaving `document.json` as authored (D′ would be planned over a
document no Nova app is ever in after a publish). `proof/CLAUDE.md`, "The capture moves with publish",
puts this in the pull request that adds the kind.

### 4.6 The census test

`proof/checks/test_corpus.py::test_the_corpus_holds_each_search_workflow_and_each_placement`, over
`Corpus.emitted`, added in pull request 3 and extended by each pull request that adds a shape: some
document holds each query-repeat placement (3); each operation placement, a basic slot and a Save to Case
block (4); some D′ moves a held placement (5); an advanced action (7); each search workflow (search first,
skip to results, list first only where Android alone is declared, and forms reading the search) (10);
and a self-link and an otherwise (11). It catches a fixture change that leaves a reader or a check with
nothing of a shape to read.

## 5. Targeted documents

### 5.1 The one list

Each is built by Nova's planner and admitted by the gate (`proof/targeted/build.ts::targetedDocument`),
with explicit identities from `targetedUuid`, appended to `proof/targeted/index.ts::TARGETED_DOCUMENTS`
and to `proof/README.md`, "Targeted documents", in the pull request named. None needs a control: each
witnesses a fix, a new shape or a migration. The last column names the area proposals each one takes
in; every part uses the names in the first column.

| Id | PR | Declared | What it holds | What it witnesses | Takes in |
|---|---|---|---|---|---|
| `targeted-migration-search-workflow` | 1 | Web Apps | §5.2 | defects 21 and 29's migration | proof's |
| `targeted-migration-case-writes` | 1 | Web Apps | §5.2 | defect 22's migration, C6, C8 | proof's; cutover's pre-step fixtures of those classes |
| `targeted-migration-attachment` | 1 | both | §5.2 | defect 23's migration | proof's |
| `targeted-migration-extension-children` | 1 | both | §5.2 | defect 24's migration, M1 to M3 | proof's |
| `targeted-migration-query-repeats` | 1 | both | §5.2 | defect 25's migration, Q1 | proof's |
| `targeted-migration-form-links` | 1 | Web Apps | §5.2 | defect 26's migration, L1 to L6 | proof's |
| `targeted-migration-groups-preloads` | 1 | both | §5.2 | defects 27 and 28's migration, Q4, C7 | proof's |
| `targeted-migration-repeat-counts` | 1 | both | §5.2 | defect 30's migration, Q2, Q3 | proof's |
| `targeted-query-repeat-placements` | 3 | both | a survey form with (a) `visits`, model iteration over `'a b'` at the root; (b) `readings`, whose query reads `#form/site` (count); (c) `children`, count placement in a user repeat `households`, its query reading the outer row's answer; (d) `stock`, count placement whose results shrink when `#form/site` changes, with a case operation per row | each placement's two Vellum saves keep it (proof 4); Core and Formplayer rows; the intent values: (a) two rows `a`, `b`; (b) rows follow the answer; (c) each household's ids; (d) after the shrink, only the relevant rows and their case blocks are submitted | proof's and part 04's (same name) |
| `targeted-repeat-count-whole` | 3 | both | counts from an `int` question, an integer single select (`1`, `2`, `3`), a Hidden Value calculating `2` (direct `jr:count`), and `int(#form/weight div 2)` (carrier) | defect 30's fix: no `nova_count_` node where none is needed; the intent's submission nodes; a proof 4 fixed point | proof's `targeted-repeat-count-integers` |
| `targeted-case-writes-one-concept` | 4 | both | a registration whose own arm writes three questions, opens under a select condition and closes the case it creates under a close condition whose answer is a choice of a static select; a child create at the root and one in a repeat; a worker-record update; a follow-up with an explicit preload default, a writer with no preload, a `via: parent` write and an `onlyIfChanged` write; a second follow-up whose own arm takes Save to Case (a computed write), so that form alone needs `save_to_case`; a close form whose close condition compares a static select with one of its choices. Its configurations grant `SAVE_ONLY_EDITED_FORM_FIELDS`. Written D′ renames the choice's value | `form-requires-none-open-case-condition-if`, `-close-case-active`, `a-writer-question-with-no-case-preload-update-only`, the `via` keys, `conditionalcaseupdate-update-mode-edit` flip here; the choice reprinted after its rename (proof 5); part 01's G3 (a child's condition on its own repeat), G4 (the form builder keeps the explicit preload) and G5 (the Case Management save keeps `update_mode: edit`) | part 01's (same name) and part 01's `targeted-registration-closes`, whose registration that closes its case it holds; the preload half of proof's `targeted-markdown-preloads` |
| `targeted-held-placement` | 5 | both | form "Update" whose own update holds a basic slot; form "Weigh" whose operation holds Save to Case because it writes a computed value. Written D′: adds to Update a write the basic slot cannot hold, and removes Weigh's computed write | the move to Save to Case stated and committed with the edit (proof 1 inside the footprint, proof 5 outside it); Weigh's held Save to Case path unchanged though the simplest placement is now basic (proof 1 across A and B-edit). Its D's holds are written by its spec in pull request 5 and come from the capture's record from pull request 6, the same placements | part 01's and part 03's `targeted-placement-held` |
| `targeted-advanced-module` | 7 | both | a household module and a patient module selecting its household (parent selection), made advanced by a carried extension create: a registration of patient (its own open action, open and close conditions); a follow-up of patient writing three questions, closing the household on its load, writing the worker's record and creating two indexed `visit` cases in one repeat (the second linked to the first); an `episode` extension create carried to "Review episode"; and a close form | every flip of §7.1's pull request 7 row (`auto-select-mode-usercase` by the worker write); advanced emission held by the bar, proof 4's Case Management and module settings saves (part 02's G2), proof 3 across HQ's build and the local injection; the extension open action's owner (part 02's G6) | part 02's and proof's (same name), which also holds the advanced half of part 02's carried chain and its worker's load; part 02's `targeted-extension-owner` |
| `targeted-extension-carried` | 7 | both | a basic module whose registration creates an extension case carried by its link into a form of its type, beside a form whose extension create no link carries | the carried create on an open action with `case_id_new_<type>_<i>` matched by the link; the uncarried one in `nova_operations` with a `uuid()` id | part 02's and proof's (same name), which also holds the basic half of part 02's carried chain |
| `targeted-advanced-child-module` | 7 | both | a basic case-selecting root menu with an advanced child menu of the same type whose forms' loads HQ aligns to the root's datums, and a create there linked to the aligned load | HQ's datum alignment (`add_parent_datums`) on both paths; the create falls to Save to Case (`link-renamed-load`) | part 02's |
| `targeted-advanced-held-kind` | 7 | both | D: a module advanced by a carried create, published; written D′ removes the link | the held kind keeps the module advanced, so proof 1 sees no move across the edit and proof 5 holds the rest | part 02's |
| `targeted-root-case-block-names` | 7 | both | a root question `subcase_0` beside a basic child create at the root; a root question `commcare_usercase` in a form writing the worker's record | part 02's G3 through the bar, proof 3 and a `CaseOperationRuntimeTest` scenario; under its outcome A the creates take Save to Case and the document witnesses that fallback | part 02's |
| `targeted-worker-underscore-write` | 7 | both | a worker property `_visits` written by a basic form through the usercase slot, and by a second form through a Save to Case block (a computed value) | part 02's G4 through the bar and proof 3; under its outcome A the basic write takes Save to Case and the document witnesses that fallback | part 02's |
| `targeted-same-type-child` | 8 | both | form A, a follow-up whose create of its menu's own case type takes a basic subcase (its verdict lists `DONT_INDEX_SAME_CASETYPE` in `flagsOff`); form B, a follow-up whose create of its own type carries a write condition, so a Save to Case block is its simplest placement, the accepted counterpart whose index the flag leaves alone. Written D′ applies the offered move to form A's create | defect 12's same-type row reproduced: the flag's flip refused and held to its effects, form A's index and bind dropped and form B's block unchanged (part 03's G4); D′'s verdict no longer requires the flag off | parts 01, 03 and proof's (same name); its two forms are part 03's |
| `targeted-supply-point-text` | 8 | both | a survey form with `instance('commcaresession')/session/data/supply_point_id` in a label in two languages and in a calculate's string literal | the CommCare Supply text reason's evidence (part 03's G2, three outcomes): proof 4's two Vellum saves and `proof/editors/test_commtrack_supply_point_text.py` | parts 02 and 03's (same name) |
| `targeted-field-list-flags` | 9 | both | a labelled group with `fieldList`, a labelled group without, an unlabelled group with, a count repeat in a field-list group, a user repeat in a group without | `question-list-unlabelled-anywhere-else` and `group-group-ref-label-no-appearance` flip here; the `question-pages` cells; Android pages as Core pages them | part 04's, proof's `targeted-field-lists` |
| `targeted-plain-labels` | 9 | both | question, group and choice labels with `plainLabel` holding `*not bold*`, `# 5`, `1. first`, `<b>tag</b>`, and the same texts with markdown | `label-with-no-markdown-form` and `choice-label-with-no-markdown-form` flip here; G5 (Android renders a plain label as written); proof 4 fixed point | part 04's, the markdown half of proof's `targeted-markdown-preloads` |
| `targeted-search-workflow` | 10 | both | one case type, three searching menus, none whose forms read the search: search first with a visible field and a Search button condition; search first with only a hidden field; skip to results with a visible field | `workflow-search-first-auto-launch-true-default-search-false` flips here; Formplayer, the client and App Preview open each as the platform table says, a device opens each list first (G3 here, part 05's G3 and G4) | part 05's and proof's (same name) |
| `targeted-search-workflow-inline` | 10 | Web Apps | search first with forms reading the search and only a hidden field; skip to results with forms reading the search and a visible field, with its case list registration form and its label | the inline entries `inline-search-true-auto-launch-true-on-a-module-without-visible` and `inline-search-default-search-on-a-module-with-visible-inputs` flip here; part 05's G3 and G4 | part 05's and proof's (same name) |
| `targeted-search-workflow-android` | 10 | Android | `workflow: "listFirst"` on a module with a visible field | the Case List page draws no selector (`cloudcare_enabled` false), so the save keeps `auto_launch: false` (part 05's G3); a device and Formplayer list first | part 05's and proof's (same name) |
| `targeted-case-list-menu-item` | 10 | both | a forms-first menu (a registration and a follow-up form) with a labelled case list entry, an image and Details columns; a case-first menu (a follow-up and a close form) with its entry and no Details columns | the case list menu item beside forms and its device half (decision 6's run, part 05's G1); `module-case-list-show-true-on-a-basic-module-with-forms` flips here | part 05's and proof's (same name), part 02's `targeted-case-list-menu-item-forms` |
| `targeted-commtrack-advanced` | 10 | both | a module made advanced by a carried create, with its case list menu item beside its forms, no filter, and the default product details part 02's emitter writes; its verdict requires CommCare Supply off | `module-case-list-show-true-on-an-advancedmodule` flips here with decision 6's reading; the lane witness of the CommCare Supply menu-item reason, whose flip is refused and held to the gate's effects (part 03's G1) | parts 02 and 03's and proof's (same name), part 03's `targeted-commtrack-case-list-menu-item` |
| `targeted-form-link-chain` | 11 | both | menu Start (no case type) with survey Begin holding three every-time destinations in order: form First, form Second (both in menu A) and menu B; First with its own every-time destination, form Nested (menu A); survey Begin both with `#user/username = 'alice'` to Second, then `true()` to menu B. Written D′: `moveFormLink` makes Begin's menu B destination first | the order every destination that holds runs in on each reader (part 06's G1, three outcomes); proof 5 over a reorder | part 06's, proof's `targeted-form-link-semantics` |
| `targeted-form-link-carried-case` | 11 | both | root Households (`household`) with registration Add household; its child Members (`member`) with registration Register member and follow-up Check member. Register member's destinations, all to Check member, each carrying `case_id`: the literal `'no-such-case'`, the new member's id (the form's created case), the selected household's id (a case of the wrong type); otherwise the first menu. Register member quietly holds only the literal and household destinations and the same otherwise. The walk makes every case it reads | the held-case guard (part 06's G2): only the destination carrying the new member opens after Register member, and the otherwise after Register member quietly | part 06's |
| `targeted-form-link-otherwise` | 11 | both | root Households with registration Add household holding a `this-form` destination; its child Checks (`member`) with registration Add member, follow-up Review member, four follow-ups each with one destination to Review member when `#user/username = 'alice'` and a built-in otherwise (`firstMenu`, `module`, `parentMenu`, `previous`), and a fifth, Check link, whose otherwise is a link to Review member carrying the form's own selected case; surveys Ping and Pong linking to each other; root Rounds (`household`) with child Round checks (`member`), to which Review member links (offered: both parents have case type `household`) | `form-links-target-the-current-form-or-a-link-cycle` and `two-or-more-form-links-conditions-true-at-once` flip here; HQ's form settings save keeps each shape (part 06's G3); `proof/views/test_form_link_targets.py` | part 06's, proof's `targeted-form-link-semantics` |

Thirty documents; at the exit the corpus holds 431 documents (398 at `main`, these thirty, and part
06's three new form-link producer documents of §4.2), the fuzz sample unchanged in count. Under part
02's G4 outcome B, `targeted-worker-underscore-write` leaves in pull request 7, so every count from
pull request 7 on is one fewer: twenty-nine targeted documents, pull request 7's six become five, and
the exit corpus holds 430. Pull request 7 writes `proof/checks/test_corpus.py`'s expected counts from
the outcome its own lane records, so the test asserts the count that outcome gives.

Part 02's G3 and G4 run on their documents' first push in pull request 7, before any clause depends
on them. Under part 02's G4 outcome B (a new validator code, `WORKER_PROPERTY_WRITE_NAME`, refuses a
form's write of such a property, through the usercase slot or Save to Case alike), the shape is one the gate refuses, so
`targeted-worker-underscore-write` leaves the list in pull request 7, its first push's records stand as
the run's evidence in `harness-findings.md`, the code's validator test pairs the refusal with an
accepted write, and the corpus holds one document fewer than counted here.

### 5.2 The migration witnesses

Each is a small app. Every witness lands in pull request 1 (§5.1's column); the pull request each item
below names is the one whose migration rewrites its spec. "Pre-step" is its spec in pull request 1
(today's shapes); "Migrated" is what its spec holds from the pull request named, which is what the
cutover's planner gives the pre-step app. A
witness's held placements are written in its spec's document as the cutover writes them for a published
app, in the pull request that adds each unit's held slot: the query repeat's (3), the operation's and the
own close's (4), the module kind's (7). The operation's slot therefore lands in pull request 4 with the
operation model, ahead of pull request 5's moves and `holdPlacements`: without it the case-writes
witness's B would put an existing operation at the simplest placement, a move no migration decides.
"Expected moves" are proof 1's differences between the old A and B that G6 expects to write; G6 writes
what the evidence shows.

1. **`targeted-migration-search-workflow`** (Web Apps; pull request 10). Pre-step: module Visits
   (`visit`) with a list-first search and a visible input; module Clinics with `searchFirst: true` and a
   visible input; module Sites with a search whose filter is effective and no input visible (today's
   derived skip to results); module Registry with `searchFirst: true` and a no-matches registration form;
   module Reports with `caseListOnly: true`. Migrated: Visits no workflow (search first), Clinics
   `formsReadSearch: true`, Sites `workflow: "skipToResults"`, Registry `formsReadSearch: true` and its
   `caseListRegistrationForm`, Reports `caseListMenuItem`. Declared Web Apps because the inline shape
   the migration renames is unavailable on Android; the both-declared list-first migration is read on
   the 26 documents of §4.2 (G2). Expected moves: none.
2. **`targeted-migration-case-writes`** (Web Apps; pull request 4). Pre-step: module
   Households (`household`, child type `member`, child type `head`): registration Register writing
   `case_name` and `village` through field writes, a `head` child at the root and a `member` child in
   the repeat `members`; module Visits (`household`): follow-up Visit with field writes, a worker-record
   write, and existing operations at the root, in a repeat, keyed by an answer and conditional; close
   form Close whose close condition is `{field: outcome, answer: "moved"}` on a static select (C6); close
   form Close in repeat whose close condition reads a question in a repeat (the own close's Save to Case
   placement); module Batch (`household`, several cases) with a form writing to the selected cases (the
   several-case wrapper). The two close conditions sit on close forms of their own because `main` admits
   a close condition only on a close form, one per form
   (`lib/commcare/validator/rules/form.ts::closeConditionValidation`). Declared Web Apps because of the
   several-case menu Android cannot open. Migrated: the operations C1 to C3 give, the
   close condition as C6 writes it, and every unit held where A carries it (C8), the holds the cutover
   writes for a published app (stored in the spec's document). Expected moves: none, the
   placement being read from the baseline.
   The production scan found part 01's class (a), a `close` operation on the form's own case in a
   follow-up form, so C9 has work at the window (part 09 §7.4) and the witness holds the shape: module
   Visits also has a follow-up Discharge whose `close` operation on its own case has a condition on a
   static select and no writes, in the Save to Case block `main` emits for it. Migrated: Discharge is a
   close form whose close condition is the operation's condition, the operation is gone, and its own
   close is held through `Form.ownClosePlacement` at the path the removed operation had. Expected
   moves: none, the close staying at its path. From pull request 4 the rule
   `CASE_OPERATION_CLOSES_OWN_CASE` (part 01) refuses the shape at the head, so no other corpus source
   holds it. The two other arms of C9, an operation that holds writes (kept as an `update` on the own
   case, its own close taking the simplest placement with the cause `own-close-moved`) and one under
   `forEach` (the blocker `own-close-in-repeat`), are held by part 09's planner fixture
   `pre-step-own-close-operation` rather than by the witness. The planning scan did not count either
   arm, so the advisory dry run says whether production holds one, and both ship as written.
3. **`targeted-migration-attachment`** (both; pull request 2). Pre-step: module Patients (`patient`),
   follow-up Photo with an image capture `photo` writing `photo` in attachment mode and a capture `scan`
   writing `scan` as a link; A's configuration grants `MM_CASE_PROPERTIES`. Migrated: both link writes
   (as operations from pull request 4). Expected moves: the answer leaf added for `photo`'s link value
   (its `/modules/*/forms/*/...` leaf), defect 23.
4. **`targeted-migration-extension-children`** (both; pull request 7). Pre-step: module Patients
   (`patient`, extension type `episode`, child type `contact`): registration Register writing a field to
   `episode` (the inert `never` subcase and its `nova_subcases/nova_subcase_0` block) and then a field to
   `contact` (`subcase_1`); module Enrollment (`patient`): registration Enroll writing a field to `episode`
   with a form link carrying the new episode into module Episodes' follow-up Review. Migrated (M1 to
   M3): Register's extension create held at its Save to Case path (published), its `contact` child moved
   up to `subcase_0`; Enroll's extension create an advanced open action, its module made advanced, its
   link's datum the open action's. Expected moves: the `subcase_<i>` path and session datum of the child
   that moves up; Enrollment's case block paths (`/data/case` to `/data/case_<tag>/case`) and its datums
   renamed (`case_id` to `case_id_load_<type><n>`), defect 24.
5. **`targeted-migration-query-repeats`** (both; pull request 3). Pre-step: survey Census with `visits`,
   a query repeat over the case list at the root; a user repeat `households` holding `members`, whose
   query reads the household row's answer; and `later`, a query repeat under a group whose relevance
   reads an answer. Migrated: `visits` held model iteration; `members` and `later` unheld, in the count
   placement, which the next publish records (Q1, a published app; part 04 §7.1, part 09 §8.3 and §8.5). Expected moves (part 04, under its G1 outcome A): the removed attribute leaves
   (`@ids`, `@count`, `@current_index`, `item/@id`, `item/@index`) and the added `nova_query_ids_r`,
   `nova_query_count_r` and `item/nova_query_id_r`, and no answer path (part 04 keeps `/data/r/item` in
   both placements), defect 25. Under part 04's G1 outcome C (the form builder cannot keep the count
   placement's outer Group) the answer paths move too, and the expected moves add them.
6. **`targeted-migration-form-links`** (Web Apps; pull request 11). Pre-step: form Intake with two
   conditional links and a terminal unconditional link; form Triage with a conditional link and a stored
   `postSubmit`; form Refer in root menu Patients with a link to its child menu Patient visits, which HQ does not offer from it (L4); form
   Record visit in child menu Patient visits with a link to child menu Patient notes carrying the
   selected patient (datums on a menu link, as `main` allows); and, in menu Batch selecting several
   cases, form Batch review with a conditional link beside `postSubmit: "previous"`. Declared Web Apps
   because the several-case menu is unavailable on Android. Migrated: part 06's map of each (L1 to L6). Expected moves: none in proof
   1's table (links and datums are no identities); the suite's stack moves, held in B's proof 4.
7. **`targeted-migration-groups-preloads`** (both; pull requests 4 and 9). Pre-step: follow-up Check with
   a labelled group `vitals`, a labelled group `household` holding a user repeat, a writer `weight` of
   the form's own case with an authored default, and a later Hidden Value whose default reads `weight`.
   Migrated: `vitals` `fieldList: true`, `household` without; `weight`'s default the case read (C7).
   Expected moves: none.
8. **`targeted-migration-repeat-counts`** (both; pull request 3). Pre-step: a count repeat whose count is
   a Hidden Value calculating `2` and a count repeat whose count is a decimal expression. Migrated: the
   first unchanged in the document (its `nova_count_<repeat>` node leaves the wire, Q3), the second
   wrapped in `int(…)` (Q2). Expected moves: the removed `nova_count_<repeat>` data path, defect 30.

Together the witnesses hold every pre-step placement class the cutover's baseline match reads (part 09):
basic primary, basic subcase at the root and in a repeat with an inert one before it, extension
`nova_subcases`, Save to Case at the root, in a repeat, keyed and conditional, the several-case wrapper,
the close block, a close operation on the form's own case, and a query repeat; so HQ's reads of their
A (§1.2) are the evidence `publishedCaseBlocks` is proven over.

**After step 5.** The witnesses stay in the corpus, as controls do. A later step whose change moves an
identity on a step 5 witness writes its move for that witness too, from the witness's evidence, scoped
to the witnesses that show it.

### 5.3 Existing targeted documents that change

| Document | PR | Change |
|---|---|---|
| `targeted-repeat-count-copy` | 3 | none in the spec; the count is direct, the submission holds four nodes, and its intent `values` are pinned again from the run |
| `targeted-query-repeat-places` | 3 | none; its expectations hold in the count placement (`count(/data/later/measured/item)` 2, `count(/data/never/missed/item)` 0) |
| `targeted-load-time-values` | 4 | `proof/targeted/documents/loadTimeValues.ts`: the weight writer carries the explicit default; the export holds no `case_preload`; the note's default reads the case value (`values` `was <case weight>`); its header describes the explicit default |
| `targeted-close-conditions`, `targeted-close-condition-unparsable` | 4 | their conditions as C6 writes them |
| `targeted-labelled-group-repeat` | 9 | `household` without `fieldList` |
| `targeted-list-first-web-apps`, `targeted-list-first-places` | 10 | keep their ids and controls; their comments say the document witnesses that a searching menu of an app with Web Apps opens on Search first, which the Case List save keeps (rows `["21"]`) |
| `targeted-sync-on-form-entry-web-apps` | 10 | its comment loses "it carries defect 21's `requests` class" |
| `targeted-inline-search-reads`, `targeted-no-matches-return-identity` | 10 | `formsReadSearch` and `caseListRegistrationForm`; no wire byte moves |
| `targeted-form-links-hidden-and-fallback` | 11 | `proof/targeted/documents/formLinksHiddenFallback.ts` in its migrated shape: the Frogs form's link to Ponds targets Sites; its `postSubmit: "previous"` becomes `otherwise: {kind: "destination", destination: "module"}`; the second link's condition is `#user/username = 'bea' and not(#user/username = 'alice')`, as L1 writes it; its header comment says what it now holds |
| `targeted-instance-reads`, `targeted-inline-search-reads` | 11 | in the shape `mapFormLinkSemantics` writes, committed as source (part 06): `instanceReads.ts`'s two conditional links take L1's conditions and its `postSubmit: "module"` becomes the otherwise (L3); `inlineSearchReads.ts`'s `postSubmit: "module"` beside a `true()` link takes L3's shape |

## 6. Native proofs and reader tests

### 6.1 Native classes

Each runs in its pull request's own lane as a package group keyed by the harness's files; new classes go
in `proof/native/families.py::CORE_CLASSES` under their family and their producers in
`proof/native/producers/`.

| PR | Class (family) | Contract and the plausible failure it catches |
|---|---|---|
| 2 | `CaseCaptureRuntimeTest` (`case`) | the attachment scenarios (`check(...)`'s `/case/attachment/photo/@src` assertions, `checkMultiple`) become link-write assertions: the case property holds `.../api/form_attachment/v1/<instanceID>/<file>` and no `<attachment>` block exists, on both paths. Catches an attachment block left in either path's case transaction |
| 3 | `ContainerRuntimeTest` (`container`) | count placement, nested, under a later-relevant group and reading an answer, on local and HQ-regenerated forms: rows follow the query as the form is filled in; a row's answers stay at its position while its id follows the record now at its place (part 04's design, its notice `repeat-rows-follow-query`); a shrink leaves rows not relevant and absent from the submission, and growth back restores them with their answers; per-outer-row ids; model iteration in Vellum's spelling initializes at load. Part 04's G2 is this class's run. Catches a row id read against the template before the row exists |
| 3 | `RepeatCountRuntimeTest` (`expression`, new) | a count from a Hidden Value calculating an integer written directly into `jr:count`, an `int(expr)` count, and the retained control of a fractional count through the old `nova_count_` node all count the same rows (`org/javarosa/xpath/expr/FunctionUtils.java::toInt`). Catches a direct count Core reads as a fraction |
| 4 | `CaseOperationRuntimeTest` (`case`) | part 01's G1 order cases (a Save to Case update and link naming a case a later basic block creates, both paths) and an `onlyIfChanged` write (the edit expression evaluated over a native case instance); the own arm's create and close under conditions. Catches a basic placement Core applies after a block that reads its case |
| 7 | `CaseOperationRuntimeTest` (`case`) | an extension link on a created operation at the root and in a repeat; `CaseXmlParser` stores the extension index with `relationship="extension"`; part 02's G3 scenario, HQ's build of `targeted-root-case-block-names` opened in Core and submitted. Catches an extension link written as a child index, and a case write lost to a question named like the block HQ appends |
| 7 | `AdvancedFormRuntimeTest` (`case`, new) and `proof/native/test_advanced_emission.py` | HQ regenerates an advanced form (`corehq/apps/app_manager/xform.py::XForm._create_casexml_advanced`, `suite_xml/sections/entries.py::EntriesHelper.get_datum_meta_assertions_advanced`) of `targeted-advanced-module`; Core's `SuiteParser` and `XFormParser` read both paths; Core opens each form from its suite session with the loads' datums, submits, and the case blocks apply: each load updates the case its datum names, the household closes, the open actions create with their indices (the `extension` one with `relationship="extension"`) and owners, the usercase load updates the worker's case, and the extension case's owner is the one part 02's G6 observes. `test_advanced_emission.py` holds HQ's `_create_casexml_advanced` and `get_datum_meta_assertions_advanced` over Nova's HQ import body equal, element for element, to the local `.ccz`, with `validate_app` returning no error. Catches a datum id or block path Nova's local suite writes differently from HQ's build |
| 11 | `FormLinkRuntimeTest` (`form-link`) | today's completion test, which asserts only the first true link and its carried case, becomes part 06's `completionRunsEveryDestinationThatHoldsInTheAuthorsOrder` (part 06 §13.5): over the wire fixture's scenarios, the new `this-form`, `chain` and `carried-held` among them, each submission's commands read in order on the local suite and HQ's regenerated one, asserting the order part 06's G1 observes on Core; new `aSelfLinkStartsTheFormAgain` and `aCarriedCaseNotOnTheDevicePushesNoFrame` (the guard false, the otherwise frame instead); `absentSourceRaisesAndEmptySourceNeverPromptsForTargetCase` keeps its automatic half and asserts the guard leaves no frame for a blank value. `proof/native/test_navigation_emission.py`: HQ's `xpath` and fallback bytes equal the local `if` bytes for every scenario. Catches the emission's reversal lost on one path |

### 6.2 Lane tests of HQ's pages, views and models

| PR | Test | Contract, pairing and plausible failure |
|---|---|---|
| 7 | `proof/hq/test_advanced_rules.py` | for each row of part 02's section 16 that names an eligibility clause or a kind blocker, an app built with HQ's own models in the shape Nova avoids fails HQ's build, its validator or its page check as the row says, and Nova's emission of the same document (falling to Save to Case, or staying basic) passes; the shapes come from a shared fixture, `proof/hq/fixtures/advanced-rule-shapes.json`, that part 02's `lib/commcare/__tests__/advancedPlacement.test.ts` writes from the production predicates. Catches a Nova eligibility clause that keeps a shape HQ builds from an advanced action, or one that lets through a shape HQ refuses |
| 9 | `proof/android/test_form_reads.py::test_a_label_without_markdown_renders_its_text_as_written` (reader `android`) | over `targeted-plain-labels`: the device shows `*`, `#` and `1. ` as typed; paired with the same texts carrying a markdown form, which render formatted (G5) |
| 10 | `proof/views/test_search_workflow_offers.py` (`offered`, HQ's Case List page in Chromium) | for `targeted-search-workflow` with `CLOUDCARE` and `SYNC_SEARCH_CASE_CLAIM`, the selector offers search first and skip to default results and shows the stored value (`corehq/apps/app_manager/views/modules.py::get_module_view_context`, `show_search_workflow`); for `targeted-search-workflow-android` (stored `cloudcare_enabled` false) it draws no selector. Paired: with `CASE_SEARCH_DEPRECATED_NORMAL_CASE_LIST` on it also offers the legacy choice, so a page that offered nothing cannot pass |
| 11 | `proof/views/test_form_link_targets.py` (`offered`, HQ's form settings page) | the link targets HQ offers for each form of `targeted-form-link-otherwise` (`corehq/apps/app_manager/views/forms.py::_get_linkable_forms_context`) equal those Nova's validator admits, read from `lib/commcare/__tests__/fixtures/formLinkTargets.json`, which part 06's `lib/commcare/__tests__/formLinkTargets.test.ts` writes from the validator's verdict over every candidate menu and form of the document (kept where no `FORM_LINK_TARGET_NOT_OFFERED` is raised, the production rule `lib/domain/formLinkTargets.ts::menuTargetOffered`; part 06 §13.6); with and without `FORM_LINK_ADVANCED_MODE`. Catches a link target Nova refuses that HQ offers, or the reverse |

Part 02's G3 and G4 are read on their targeted documents (§5.1) through the bar, proof 3 and the
`CaseOperationRuntimeTest` scenario of §6.1, not on apps built with HQ's models: under outcome A of
each the document stays admissible and witnesses the Save to Case fallback.

Part 03's lane tests (`proof/editors/test_commtrack_supply_point_text.py`, `proof/hq/test_flag_probe.py`
with `DONT_INDEX_SAME_CASETYPE`, `proof/targeted/__tests__/publishChecks.test.ts`) land in pull request 8
as part 03 writes them. `proof/targeted/__tests__/unproducedInputs.test.ts` changes in three of its four
bullets: "defect 23 without `MM_CASE_PROPERTIES`" leaves in pull request 2 (no input remains); "a basic
child case of its own menu's case type" and "defect 20's `product_id` datum" move to
`publishChecks.test.ts` in pull request 8 (part 03), each now produced and checked at publish; the
supply-point read bullet stays. Its header's paragraph is rewritten in each of those pull requests.

## 7. Manifest flips, value-class readers and gate effects

Each flip edits its inventory row under `docs/research/2026-09-26-hq-round-trip/inventory/` in the same
pull request; each entry whose readings differ by platform lands with its platform row
(`lib/commcare/surface/platformFeatureEntries.ts`, held by
`lib/commcare/surface/__tests__/platformFeatures.test.ts`) and its Preview cells
(`lib/preview/__tests__/platformCells.ts`, held by `platformCells.test.ts`), whose copy the owning part
writes. The lane's part is the readings and the reader evidence each row cites.

### 7.1 HELD-NEW to HELD, by pull request

| PR | Entries (prefix) | Readings |
|---|---|---|
| 3 | `questions/count-repeat-whose-count-and-row-ids-come-from-one-query-a`; cells rewritten on `repeat-model-iteration-vellum-role-repeat-ids-count-current` (marker `save-breaking` dropped), `jr-count-naming-a-hidden-value-whose-calculate-is-an-integer-in`, `jr-count-naming-a-single-select-question-whose-every-choice` | RUNS / RUNS |
| 4 | `forms-and-case-writes/form-requires-none-open-case-condition-if`, `form-requires-none-open-case-close-case-active`, `a-writer-question-with-no-case-preload-update-only`, `conditionalcaseupdate-update-mode-edit` (part 01's G5 outcome A), `update-key-whose-index-segments-are-each-parent-or-host-parent-p`, `update-key-whose-index-segments-include-user-each-parent-host-or`, `update-key-owner-id`, `close-case-condition-if-operator-boolean-true-on-a-requires-case`, `subcases-condition-if`, `subcases-close-condition-active` | RUNS / RUNS |
| 7 | `menus-and-case-lists/advancedmodule`; `forms-and-case-writes/advancedform`, `load-update-cases-loadupdateaction`, `loadupdateaction-case-tag-without`, `loadupdateaction-case-type`, `loadupdateaction-details-module`, `loadupdateaction-case-properties`, `loadupdateaction-close-condition-on-the-form-s-own-selection`, `loadupdateaction-close-condition-on-any-other-selection`, `loadupdateaction-case-index-tag-reference-id-relationship`, `open-cases-advancedopencaseaction-the-one-open-action-outside`, `open-cases-advancedopencaseaction-any-other`, `advancedopencaseaction-name-update`, `advancedopencaseaction-case-properties-keys-without`, `advancedopencaseaction-close-condition`, `advancedopencaseaction-repeat-context-equal-to-the-name-question`, `advancedopencaseaction-open-condition`, `advancedopencaseaction-case-indices-child-extension-one-or-many`, `an-advanced-open-action-indexed-to-an-open-action-that-has-a-equal`, `auto-select-mode-usercase` | RUNS / RUNS |
| 9 | `questions/question-list-unlabelled-anywhere-else` (joins `question-pages`), `group-group-ref-label-no-appearance`, `label-with-no-markdown-form`; new split `questions/choice-label-with-no-markdown-form` (HELD) | IGNORED / RUNS; RUNS / RUNS; RUNS / RUNS (literal, G5); `different` / `runs` |
| 10 | `case-search/workflow-search-first-auto-launch-true-default-search-false` (feature `search-first`), `inline-search-true-auto-launch-true-on-a-module-without-visible` and `inline-search-default-search-on-a-module-with-visible-inputs` (feature `forms-read-search`); `menus-and-case-lists/module-case-list-show-true-on-a-basic-module-with-forms` and `module-case-list-show-true-on-an-advancedmodule` (decision 6's reading); the ambient `auto-launch-false-in-an-app-with-cloudcare-enabled-false` stays ambient with its cell rewritten (part 05's C1: its reading is not-applicable, so it cannot carry a feature), and list first becomes the `list-first` row through the new `case-search/list-first-where-web-apps-is-declared` (export use) | RUNS / IGNORED; RUNS / UNAVAILABLE; decision 6's |
| 11 | `forms-and-case-writes/two-or-more-form-links-conditions-true-at-once` (feature `after-submit-several-destinations` under part 06's G1 outcome A), `form-links-target-the-current-form-or-a-link-cycle` | part 06's G1; RUNS / RUNS |

Stay HELD-NEW in step 5 (no Nova document emits them): `loadupdateaction-preload-question-property`
(an advanced load's preload: a writer's starting value is its explicit default, part 02 section 11),
the four other `auto-select-mode-*` entries,
`auto-select-case-on-an-advanced-module`, `case-type-commcare-user-on-an-advancedmodule`,
`caseindex-relationship-question-relationship-question-the-index-naming-a`,
`an-advanced-load-s-update-or-preload-or-an-open-action-s-name-or`, `arbitrary-datums-datum-id-datum-function`,
`more-than-one-address-column-in-a-detail-of-an-advanced-module`,
`a-custom-long-tile-row-mixing-fields-of-two-tabs-in-an-advanced`, the four
`menus-and-case-lists/case-list-form-*` entries beyond the after-empty-search arm, and
`expressions-and-data/session-data-supply-point-id-in-an-advanced-form-whose-computed`.

REFUSED entries Nova stops emitting keep REFUSED: `subcases-relationship-extension` (`extension`),
`subcases-condition-never` (`subcase-never`), `update-from-an-upload-question-attachment-mode`
(`upload-question`), `questions/attachment-inside-a-savetocase-block`,
`questions/model-iteration-repeat-nested-in-another-repeat-of-any-kind`,
`model-iteration-repeat-under-an-ancestor-that-core-s-load-can`,
`model-iteration-repeat-whose-query-reads-a-form-answer-that-is`,
`user-controlled-repeat-inside-a-question-list-a-group-whose`,
`jr-count-naming-a-hidden-value-whose-calculate-is-not-an-integer`, `jr-count-naming-a-decimal-question`,
`form-links-target-any-other-module`, `post-form-workflow-fallback-module-parent-module-or-previous`,
`form-links-datums-with-other-names-or-on-a-module-target`,
`case-preload-into-a-question-outside-any-repeat-where-the-held` (`load-changes-values`),
`case-search/workflow-legacy-classic-auto-launch-false-in-an-app-with` (`list-first-with-web-apps`).

### 7.2 Value-class readers

Each REFUSED value class on a key Nova newly emits gets its reader in
`proof/checks/manifest_value_classes.py::VALUE_CLASSES` in the pull request that first emits the key,
unless its entry's reason says HQ's build alone refuses it (the bar then holds it); otherwise the
manifest check reports `/undecided/`, which the register refuses.

- **Pull request 7, advanced emission**: `tag-with-slash`, `blank-tag`, `tag-failing-editor-check`,
  `slash-property-on-indexed-load`, `index-on-auto-select-or-first-load`, `tag-names-no-action`,
  `tag-names-other-than-previous-load`, `open-action-slash-key`, `shared-block-in-repeat`,
  `not-name-question-repeat`, `tag-names-own-or-later-open-action`, `load-with-renamed-datum`,
  `relationship-question-in-repeat`, `question-relationship-to-open-action`,
  `question-relationship-after-open-action-index`, `outside-parent-repeat`, `breaks-case-list-form-rules`,
  and the classes of `menus-and-case-lists/case-list-form-missing-not-a-registration-form-toggle-off-or`
  that an advanced module reaches. Each reader is pure over the export's JSON and source, tested in
  `proof/checks/test_manifest_value_classes.py` with a refused and an accepted use.
- **Pull request 8, same-type child links**: the existing reader `own_case_type_where_same_type_unindexed`
  (`forms-and-case-writes/subcase-of-the-module-s-own-case-type-in-a-project-space-with`) answers None
  for a same-type child today, because the flag is not in the export; from pull request 8 Nova emits one
  (`targeted-same-type-child`'s form A), so the reader reads the configuration's flags: the use is in
  the class only where the configuration turns `DONT_INDEX_SAME_CASETYPE` on, which a verdict's
  `flagsOff` keeps from every checked configuration. Its test pairs a configuration with the flag on
  (in the class) with one without it (not in the class). Under part 03's G4 outcome B (the build ignores
  the flag for Nova's shape) the entry's reason is corrected with that run as evidence, as part 03
  records the claim, and the reader answers not in the class for Nova's shape in any configuration.
- **Pull request 11, form links**: `failing-link-checks`.
- The auto-select classes need no reader in step 5: no Nova document emits auto-select but the usercase
  load.

### 7.3 Gate entries

| PR | Gate | Change |
|---|---|---|
| 4 | `toggle/SAVE_ONLY_EDITED_FORM_FIELDS` | `target-owned`; preflight `{kind: "capability"}` naming `save-only-edited-answers` (part 01) |
| 2 | `toggle/MM_CASE_PROPERTIES` | keeps `preflight: refusal`; no export needs it, so the probe stops asking (part 01) |
| 7 | `toggle/APP_BUILDER_ADVANCED` | keeps preflight none, or under G4's outcome C takes the probe; `effects` from G4 |
| 7, 10 | `project-space-setting/Domain.commtrack_enabled` | `effects` from G4 (every advanced module, pull request 7; the case list menu item's entry, pull request 10); `content` from part 03 in pull request 8 |
| 8 | `toggle/DONT_INDEX_SAME_CASETYPE` | `effects` from part 03's G4 over `targeted-same-type-child` |

Under part 01's G5 outcome B (the Case Management save clears `update_mode: edit`), §5.1's
`targeted-case-writes-one-concept` drops its `onlyIfChanged` write and its `SAVE_ONLY_EDITED_FORM_FIELDS`
grant, §6.1's row 4 `CaseOperationRuntimeTest` drops its `onlyIfChanged` case, and the gate row for
`toggle/SAVE_ONLY_EDITED_FORM_FIELDS` keeps `preflight: precondition`.

The weekly whole run without the readers holds every committed effect to its own flips both ways, so an
effect no flip shows any longer fails the week by name.

## 8. CI cost and the stack's order

### 8.1 The rows (`proof/README.md`, "Timings and what the lane is expected to take")

| The change | Groups | Shards | Expected end |
|---|---|---|---|
| nothing the lane reads | the audit sample | 1 | 5.6 to 6.1 min |
| a judge's file (`proof/checks/**`, `proof/rules/**`, a register, walk stops, the surface) | all 514, judged from stored records | 3 | 11.5 min |
| the observation's code, the image, or most documents | all 514, observed afresh | 12 | 13.5 min (809 s) |

A pull request's store restore reads main's newest snapshot and its own scope only
(`proof/ci/store-keys.mjs`), so a stacked pull request's row is everything between main and its head.

### 8.2 What each pull request costs

| # | Row | Why |
|---|---|---|
| 1 | 13.5 min, 12 shards, plus the eight witnesses | `proof/store/queue.py` is in the observation's partition (§1.5); the judges and the register loader change |
| 2 to 16 | 13.5 min, 12 shards each, plus the targeted documents each adds | pull request 1's observation change is beneath each; 2, 3, 4, 6, 7, 9, 10 and 11 also move most documents' keys (an emission change, or the capture's record) |

The corpus grows by thirty-three documents (thirty targeted, three form-link producer documents;
thirty-two under part 02's G4 outcome B), at
about 24 seconds each on one worker without the readers at the median, the advanced documents above it; G7 measures whether `plan fit` gives a thirteenth shard.

### 8.3 What a push costs

A push to pull request k starts 17 − k lane runs of 12 shard-jobs each, beside each run's corpus,
gate, test, smoke and build jobs; a shard's job takes 317 to 542 seconds on the measured fresh run
(run 40287062122).

| Push to | Lanes | Shard-jobs | Rounds of twenty | Rounds of six |
|---|---|---|---|---|
| 1, or cutting the stack | 16 | 192 | 10 | 32 |
| 2, attachment | 15 | 180 | 9 | 30 |
| 4, case writes | 13 | 156 | 8 | 26 |
| 6, publish placements | 11 | 132 | 7 | 22 |
| 7, advanced | 10 | 120 | 6 | 20 |
| 10, search | 7 | 84 | 5 | 14 |
| 11, form links | 6 | 72 | 4 | 12 |
| 14, cutover | 3 | 36 | 2 | 6 |
| 16, removal | 1 | 12 | 1 | 2 |

GitHub's free plan runs about twenty jobs at once across the account; while a scheduled lane with the
readers holds fourteen, six remain. On this model (ten rounds of twenty, or thirty-two of six, at up to
542 seconds a shard-job) a restack from pull request 1 is about ninety minutes
of the whole account before the top pull request's verdict, and over four hours while a scheduled lane
runs (the week from Saturday 19:07 UTC to Sunday evening, the pin pull request from Monday 00:37 UTC,
the image comparison from Monday 17:17 UTC). So:

- Pull request 1 is settled on its own branch before the stack is cut: its lane, its tests, G1's
  retention and its run by hand. It moves what every later lane reads (the queue, the witnesses, the
  retained A), so a fix to it after the cut restacks fifteen lanes.
- A fix-up goes to the pull request it belongs in, a session's pushes are one push of the stack
  (`gh stack`), and no restack is pushed while a scheduled lane with the readers runs.
- The runs by hand of §8.4 run at a head and restack nothing.

### 8.4 Reader runs by hand before the merge

The pull request lane runs no served reader (`PROOF_READERS=0`), and the gate leaves the readers'
register and walk-stop entries to the nightly, so a served entry moving or a stop leaving its document
is seen before the merge only in a run started by hand on GitHub's runners (`proof/README.md`, "Seeing a
reader's verdict before a merge"). None runs on the person's machine. Each names documents (one of them
edited) and, from pull request 1, the controls whose fixed entries it must show (`control:<id>`, §1.5);
its gate holds them; `mechanics_shards=auto` sizes it. Each is started at its pull request's head once
that pull request's lane holds, and read with `gh run list --workflow proof-audit.yml --branch <branch>
--limit 1`, `gh run watch <id> --exit-status` and `gh run view <id> --web`. The command is
`gh workflow run proof-audit.yml --ref <branch> -f nightly=false -f mechanics=<ids> -f mechanics_shards=auto -f mechanics_readers=true`.

| Head | `mechanics` | What it must show |
|---|---|---|
| 1 | the eight witnesses, `case-capture-multiple` | every reader reads each witness's A and B, no difference beyond proof 1's (none at pull request 1, its D being the pre-step app), and a stop on a witness's A, if any, is held by an entry naming the witness (§1.2) |
| 2 | `case-capture-multiple,case-extension-multiple,case-extension-multiple-repeat,case-extension-query,case-extension-registration,case-extension-repeat,targeted-migration-attachment,control:case-capture-multiple-after-13,control:case-extension-multiple-after-13,control:case-extension-multiple-repeat-after-13,control:case-extension-query-after-13,control:case-extension-registration-after-13,control:case-extension-repeat-after-13` | defect 23's ten `formplayer` entries show on their controls and on no document (G2) |
| 3 | `container-query-conditional,container-nested-query,targeted-query-repeat-places,targeted-query-repeat-placements,case-operation-query,targeted-repeat-count-whole,targeted-migration-query-repeats,targeted-migration-repeat-counts,control:container-query-conditional-after-13,control:container-nested-query,control:targeted-query-repeat-places` | defect 25's 61 served entries on their controls only; Android's nested-query form stop is gone from the document; part 04's G1 (its editor saves and served readers over query repeats and counts), which is this dispatch |
| 4 | `targeted-case-writes-one-concept,targeted-load-time-values,case-operation-link,targeted-migration-case-writes,targeted-migration-groups-preloads,case-operation-query` | the new document read by every reader, no stop; part 01's G3 (per-row condition); `case-operation-link`'s stop as §3 expects |
| 7 | `targeted-advanced-module,targeted-extension-carried,targeted-advanced-child-module,targeted-advanced-held-kind,targeted-root-case-block-names,targeted-worker-underscore-write,case-extension-registration,case-extension-query,case-extension-repeat,targeted-migration-extension-children,control:case-extension-query-after-13,control:case-extension-query-after-59,control:case-extension-registration-after-13,control:case-extension-registration-after-59,control:case-extension-repeat-after-13,control:case-extension-repeat-after-59` | defect 24's eight `formplayer@local.ccz` entries on their controls only; the advanced documents read by every reader with no stop; part 02's by-hand list (its section 24.1) is a subset of this row |
| 9 | `targeted-field-list-flags,targeted-plain-labels,targeted-labelled-group-repeat,targeted-migration-groups-preloads`, and G5's slice | the field-list screens and plain labels as Preview's cells state (part 04's G3, which is this dispatch); G5 |
| 10 | `targeted-list-first-web-apps,targeted-list-first-places,tile-grouped-search,case-list-match-none,prompt-widgets,case-list-local,targeted-search-workflow,targeted-search-workflow-inline,targeted-search-workflow-android,targeted-case-list-menu-item,targeted-commtrack-advanced,targeted-migration-search-workflow,expander-form-links-emission-forwards-literal-condition-47c96355-0`, plus every document whose emitted `auto_launch` flips (§4.2), with the controls of the same names | G2 and G3 here; decision 6's run (part 05's G1), part 05's G2 (every document whose search turns search first) and its G4 (a Search screen with no visible field), which are this one dispatch, planned once |
| 11 | `targeted-form-links-hidden-and-fallback,targeted-form-link-chain,targeted-form-link-carried-case,targeted-form-link-otherwise,form-link-else,expander-form-links-emission-forwards-literal-condition-47c96355-0,targeted-migration-form-links,control:targeted-form-links-hidden-and-fallback,control:expander-form-links-emission-forwards-literal-condition-47c96355-0` | defect 26's nine served entries on their controls only; part 06's G1 and G2 |
| top of the stack | the union of the lists above | everything above at the head that merges, before `gh stack merge` |

Pull requests 5, 6, 8 and 12 to 16 have no row: 5 and 6 move keys whose readers' records the top run
reads, 8's runs are part 03's lane runs without the readers, and 12 to 16 change no emission. Both
outcomes of each stop are planned (§3 and G2); a stop the table does not foresee is read from the run's
`checks/stops/<kind>-<document>.json`, and gets its entry in the same pull request by the rules of "Walk
stops", or is a fix to the walk where a worker would get past it.

### 8.5 The first night after the merge

The stack merges together (`gh stack merge`, one deploy), and its emission and observation move every
key, so the next scheduled night (03:23 UTC, Tuesday to Saturday) is the whole lane with every reader:
about 13.5 hours on up to fourteen of the account's twenty runners, and about half an hour more for the
thirty-three new documents at the median document's cost with the readers. The merge is made Monday to
Friday so that night follows it. Its issue, where it fails, names each failing group, why, and the
command that reruns it (`python3 -m proof.lane.report`); each failing slice is fixed in its own pull
request at that command's slice (G8). Pull request 15 refreshes `proof/timings.json`'s `no-readers` profile from
a fresh dispatch (G7); the `readers` profile is refreshed from that first night's run in the one pull
request G8's outcome A names.

## 9. Lane docs

### 9.1 `proof/README.md`

| Section | Today | From |
|---|---|---|
| "Identity moves" | "`proof/identity-moves.json` lists each identity change a migration decides, `{"defect", "entity", "path"}`; proof 1 accepts exactly those. It stays empty by design. ..." | pull request 1: "`proof/identity-moves.json` lists each identity change a migration decides, `{"defect", "entity", "path", "documents"}`, and proof 1 accepts a move only on the migration witnesses it names: targeted documents whose state A is the export of an app from before the migration, retained under `proof/migrations/<id>/`, and whose B is Nova's republish of the migrated document over it. On every other document proof 1 compares two exports of the current document by the current code, where no move applies, so a move never hides a regression elsewhere. Each move is written from its witness's proof 1 evidence, and the cutover's planner tests hold each witness's document to what the planner makes of the app it was before." |
| "A, B and B-edit" | no witness | pull request 1: a paragraph "A migration witness's A is the retained export of the app from before its migration, and B is Nova's republish of the migrated document over it; the bar, the intent and manifest checks and proof 4 judge B, proof 1 compares the two, and proofs 2, 3 and 5 and configuration sensitivity do not run on it." |
| "Configurations" | "Sync cases on form entry and CommTrack are each off, but where a reproduction turns one on ..." | pull request 1 adds "A document whose verdict requires CommCare Supply off (`minimumConfiguration.commtrackEnabled: false`, where Nova's publish asks the `commtrack-off` confirmation) may not turn it on."; pull request 8 adds "A flag a verdict lists in `minimumConfiguration.flagsOff` is never on in its configurations." |
| "The run started by hand" | documents only | pull request 1: `control:<id>` (§1.5) |
| "Known defects" | "steps 2 and 3 fixed every other defect they registered" | pull request 11: "steps 2 to 5 fixed every defect they registered, and the register holds none from step 5's exit; a later step that registers one adds it to `OPEN_DEFECTS` with its step." |
| "The defect rows" | rows 21, 23 to 28 and 30 live; "12, same-type child" in "One row is not reproduced" | each in its pull request: "Fixed in step 5: <the fix>", and "fixed; still shown by the control(s) <§2.3's controls>"; pull request 8 makes row 12 a reproduced row: "a basic child case of its own menu's type, which Nova's publish refuses where the project space has `DONT_INDEX_SAME_CASETYPE` and offers to move to a Save to Case placement; `targeted-same-type-child` holds it" |
| "Walk stops" | step 4's paragraph | pull request 10: the outcome of §3 for `tile-grouped-search` and `prompt-widgets`, and any stop G2 adds |
| "Targeted documents" | | each pull request of §5.1 adds its documents |
| "The corpus", "Platforms" | "The fuzz generators draw no declaration: the last step of each generator's `lowerToDoc` maps the draw through `declaredForContent` ..." | pull request 3, extended by 4, 9 and 10: "maps each step 5 shape of the draw as the cutover maps a stored app (whole-number counts, field writes into operations, explicit preloads, field lists, the search workflow), then ..." |
| "Native proofs", "The families" | | the scenarios of §6.1 |
| "Timings and what the lane is expected to take" | 398 documents, 86 controls, 514 groups | pull request 15: refreshed from G7 |

### 9.2 `proof/CLAUDE.md`

- "The register is strict ..." gains, after "A fix moves its entries to `fixed-defects.json` in the same
  pull request" (pull request 11): "From step 5 the known register is empty; an entry added later names a
  defect `OPEN_DEFECTS` gives to a later step."
- A new bullet after "The capture moves with publish" (pull request 1): "**A republish after a migration
  is observed on its witness.** A migration that changes the wire or an identity has a targeted witness
  whose A is the retained export from before it (`proof/migrations/<id>/`) and whose B is Nova's
  republish of the migrated document; proof 1 accepts there only the identity moves
  `proof/identity-moves.json` scopes to it, and nowhere else. Never widen a move to other documents or
  write its path by hand: write it from the witness's proof 1 evidence."

### 9.3 `docs/research/2026-09-26-hq-round-trip/harness-findings.md`, "Found while planning step 5"

This part's items: the stack's order constraint (§2.2); the README's "Identity moves" claim that the file
stays empty by design, which contradicts the research's "Proof when a feature is built" and the outline's
exit, resolved by scoped moves (§1.2); `_cheapest_edited`, a Nova defect of the lane no check observed
(§1.1); the three bullets of `unproducedInputs.test.ts` that step 5 makes untrue (§6.2); and, with part
06, Core's stack order at the pins (`org/commcare/session/CommCareSession.java::executeStackOperations`,
`finishAndPop`), which the outline's "every matching destination runs, in the author's order" did not
state.

## Tests

Every test below runs in the proof lane (the lane's pytest in the image) or in ordinary CI's Vitest for
`proof/**/__tests__/`; none needs Postgres outside the lane. Each states its boundary (`docs/testing.md`).

| Test | PR | Boundary and why |
|---|---|---|
| `test_judge_purity.py::test_the_cheapest_edited_falls_back_to_a_fixed_entrys_control` | 1 | pure over tmp corpus and registers: the selection rule alone; the manifest judge test exercises it on the real corpus |
| `test_registers.py::test_an_identity_move_holds_only_on_the_witnesses_it_names`, `test_proof1_accepts_exactly_the_identity_moves_the_register_names` | 1 | pure over tmp registers: the loader's refusals paired with an accepted file; plausible failure a move accepted on a non-witness |
| `test_registers.py::test_every_live_defect_is_a_later_steps` | 2 to 11 | the registry contract over the real register; fails a step 5 entry left live |
| `test_corpus.py::test_every_migration_witness_has_its_retained_a`, `test_every_identity_move_names_a_witness_of_the_corpus` | 1 | over `Corpus.emitted` and the committed directories: the layout's two directions |
| `test_corpus.py::test_the_corpus_holds_each_search_workflow_and_each_placement` | 3, extended | over `Corpus.emitted`: a fixture change that leaves a shape unread |
| `test_sensitivity.py`, `test_proof5_locality.py` (`commtrackEnabled`; `flagsOff`) | 1; 8 | pure over tmp verdicts, each value of each key, as step 4's sync tests |
| `test_manifest_value_classes.py` (§7.2's readers) | 7, 8, 11 | pure: each reader with a refused and an accepted use |
| `proof/store/test_queue.py::test_a_run_by_hand_may_name_a_control` | 1 | pure over a tmp proof dir: the queue's selection |
| `proof/hq/test_retained_reads.py` (migration groups) | 1 | HQ's own views over the retained A: a read written by hand, a stale read after a pin |
| `proof/corpus/__tests__/publish.test.ts` (retained A, verdict keys, placement record) | 1, 6, 8 | the capture through Nova's publish lifecycle against the loopback peer |
| `proof/corpus/__tests__/emitCorpus.test.ts` (CommCare Supply on refused) | 1 | the corpus writer's refusal and its accepted counterpart |
| `proof/corpus/__tests__/fuzzSample.test.ts` (the mapping) | 3, 4, 9, 10 | the generators and planners, with the prefix property |
| `proof/corpus/__tests__/editBatches.test.ts` (holds, otherwise) | 5, 11 | the edit planner through the commit gate and the kernel's rule |
| `proof/targeted/__tests__/targeted.test.ts` (each new document admitted; witnesses' configurations) | 1 to 11 | Nova's planner and gate |
| `proof/targeted/__tests__/unproducedInputs.test.ts` (rewritten) | 2, 8 | Nova's parser, gate and exports, the remaining bullet with its accepted counterpart |
| native classes of §6.1, lane tests of §6.2 | as named | CommCare's own code, each with its plausible failure there |

## Executed during planning

- **The registers read** at `2f985ed6` with Python's standard library: `proof/known-defects.json` (271,
  by defect, check, document, control and served reader, §2.1 and the appendix), `proof/fixed-defects.json` (746;
  none collides with a known entry; the eleven edited controls fixed `manifest` entries name, §1.1),
  `proof/walk-stops.json` (25), `proof/identity-moves.json` (`[]`), `proof/controls/` (108, the 28 the known
  register names, the 17 named by it alone, which of them keep an `edit/`).
- **A census of the corpus's sources** (`node --conditions=react-server --import tsx` over
  `producerDocuments`, `targetedDocuments` and `workforceDocuments`, 228 documents, in memory, a few
  seconds; nothing written, nothing emitted), read with `lib/domain/modules.ts::effectiveCaseSearchConfig`
  and `moduleOpensOnSearch`; and the three fuzz generators read for what they draw (§4.1).
- **Reads of the lane** at `2f985ed6`: `proof/checks/registers.py` (`OPEN_DEFECTS`, `MOVE_KEYS`,
  `IdentityMove`, `load_identity_moves`, `accepted_moves`, `held_fixed`), `test_registers.py`,
  `test_judge_purity.py::_cheapest_edited` and its three callers, `test_proof1_identity.py`,
  `corpus.py` (`Document`, `verdict_lacks`, `load_controls`), `cases.py`, `sensitivity.py::accepts`,
  `proof5.py::_edit_lacks`, `proof/store/queue.py` (`_controls_of`, `only:`), `proof/lane/blocks.py`,
  `proof/corpus/publish.ts::novaPublishVerdict`, `entryWriter.ts` (`sourceName`, the sync refusal),
  `emitCorpus.ts` (`requireEveryKind`, `UnlandedKindsError`), `editKinds.ts::EDIT_KIND_GENERATORS`,
  `editBatches.ts` (the balanced assignment), `documents.ts` (expander ids), `fuzzSample.ts`,
  `proof/targeted/build.ts::TargetedSpec`, `proof/hq/test_retained_reads.py`, and `proof/README.md`'s
  timings rows and by-hand run.
- **Reads of the manifest entries** (`lib/commcare/surface/entries/*.json`): every HELD-NEW entry of
  `forms-and-case-writes`, `menus-and-case-lists`, `questions` and `case-search` with its per-platform
  cell (§7.1).
- **Reads at the pins**, in place: commcare-hq `corehq/apps/app_manager/views/modules.py::get_module_view_context`
  (`show_search_workflow`), `views/apps.py` (`show_advanced`), `corehq/toggles/__init__.py::APP_BUILDER_ADVANCED`,
  `suite_xml/sections/entries.py::EntriesHelper.entry_for_module`, `models/modules.py::ModuleDetailsMixin.get_details`;
  commcare-core `org/commcare/session/CommCareSession.java::executeStackOperations`, `finishAndPop`.
- Nothing was run in HQ, Core, Formplayer, a browser, Docker or the lane, and no test or build ran.

## Written and not yet run

Every run here is on GitHub's runners, never the person's machine, and costs nothing on this public
repository.

**G1. The witnesses' retained A and HQ's reads of it** (pull request 1). Where: pull request 1's own CI
run, its first commit holding the eight pre-step specs, `migrationWitness` read by nothing yet but the
source name, and the retained-reads migration groups reading the corpus document's export. Then:

```bash
gh run download <run id> -n proof-corpus-<attempt>.tar.zst -D <dir>
mkdir <dir>/corpus && zstd -dc <dir>/proof-corpus-<attempt>.tar.zst | tar -x -C <dir>/corpus
for id in <the eight>; do python3 -m proof.checks.controls <dir>/corpus "$id" --migration-a; done
gh run download <run id> -n proof-out-<shard>-<attempt> -D <dir>/out   # the shards that ran test_retained_reads.py
cp -r <dir>/out/hq-reads/targeted-migration-* proof/hq-reads/
```

committed as the pull request's second commit, after which the capture republishes over the retained A
and the groups read `proof/migrations/<id>/`.
- *Outcome A:* every witness is emitted, its A is retained, and HQ's read of each holds a block
  `publishedCaseBlocks` finds for every placement class of §5.2: the second commit's lane passes with the
  same reads byte for byte, and the reads stand as the cutover's evidence (part 09's G4 outcome A).
- *Outcome B:* a placement class has no read holding its block (HQ's read drops or rewrites it): the
  witness and its read still stand (they are what HQ holds); part 09's G4 outcome B applies (that class
  is never held, its deployments get `form-data-paths-move` with cause `placement-simplified`), and that
  witness's migrated spec takes the simplest placement for the unit, with its moved paths then G6's to
  write.
- *Outcome C:* a pre-step spec is refused by `main`'s gate or its capture stops: the spec is corrected in
  the first commit (it must be an app `main` admits and publishes), and the run repeats; nothing is
  retained from a run that did not emit all eight.

**G2. Each register move's served entries, by hand, before the merge** (pull requests 2, 3, 7, 10 and
11, §8.4's rows).
- *Outcome A:* every moved served entry's class shows on its control and no longer on its document; no
  new stop.
- *Outcome B:* a served class still shows on a document: the fix is incomplete on that reader and is
  completed in the same pull request (§2.6), never re-registered. Or a fixed entry does not show on its
  control: the lane's judge or the run's grant blinded it, which is the regression the control exists to
  catch, fixed in the lane in that pull request.
- *Outcome C (pull request 10 only):* a stop's cause changes on `tile-grouped-search` or `prompt-widgets`,
  or a document newly searching first stops at a required prompt: the entry is rewritten, or added, from
  `checks/stops/<kind>-<document>.json` (same reader, the new cause and reason) in pull request 10; the
  counts of §2.5 state the stops it leaves. This is part 05's G2 outcome B, read in the same dispatch.

**G3. List first turned search first changes nothing a device reads, and the expander's defect 21
entry** (pull request 10's row of §8.4, with every reader).
- *Outcome A:* Android's records of the 26 both-declared documents equal main's (a device never reads
  `auto_launch`), and `expander-form-links-emission-forwards-literal-condition-47c96355-0`'s
  `formplayer` defect 21 class no longer shows on the document: its entry moves in pull request 10 with
  the other 36.
- *Outcome B:* the expander document still shows the class: its entry stays live in pull request 10,
  `OPEN_DEFECTS` keeps 21 there, and pull request 11, which rewrites that document's test, moves it with
  defect 26's two, dropping 21 and 26 together (§2.5's outcome B row).
- *Outcome C:* a device record differs on a both-declared document: the manifest's IGNORED reading for
  Android of `workflow-search-first-auto-launch-true-default-search-false` is wrong, corrected at the
  pins with the difference as evidence before it flips, and the `search-first` row and its cells read it
  (part 05 writes the row); `harness-findings.md` records the corrected reading.

**G4. The advanced documents' gate effects** (pull request 7). The pull request's own lane runs every
group fresh (its emission moves every advanced document's key), and its effects are written from it:
`python3 -m proof.checks.sensitivity effects <outputs>/proof-out-*/blocks/* --corpus <corpus>`.
- *Outcome A:* `project-space-setting/Domain.commtrack_enabled` gains effects only on the advanced
  documents (the `product_short` detail every advanced module gets), the flips are accepted (no verdict
  requires CommCare Supply off before pull request 8) and held to those effects; `APP_BUILDER_ADVANCED`'s
  effects stay `null` (HQ's build does not read it).
- *Outcome B:* the flip changes the build of a document beyond the advanced ones, or HQ's validation
  fails under CommCare Supply on an advanced document: part 03's G1 outcomes apply. Part 02's emitter
  already writes HQ's default single `name` product column from pull request 7, so its outcome B
  corrects that column to the spelling HQ's check reads in pull request 7, and the run repeats; its
  outcome C, a changed build on a document whose verdict does not require CommCare Supply off,
  widens `commtrackReasons` to that shape in pull request 8, with the document as its witness.
- *Outcome C:* the build reads `APP_BUILDER_ADVANCED`: its effects are written from the run, and from
  pull request 7 publish asks for the flag wherever an emitted module is advanced, as it asks
  `CASE_SEARCH_ADVANCED` for a module whose search needs it
  (`lib/commcare/projectSpaceCompatibility.ts::advancedCaseSearchReasons`): the flag joins
  `HQ_PRIVATE_FEATURE_FLAG_SYMBOLS` (a domain toggle, `corehq/toggles/__init__.py::APP_BUILDER_ADVANCED`),
  the gate entry's preflight becomes that probe, a space with the flag off is refused
  `project_space_incompatible` naming each advanced menu, and part 02's decision 19 is replaced by this
  rule in pull request 7, before the merge. The capability's catalog record lands in pull request 7, and
  `project-space-compatibility.mdx` renders it from the records with no prose edit.
In pull request 10 the same command over that pull request's run adds the case list menu item's effect
(the `product_id` datum) on `targeted-commtrack-advanced`, whose flip its verdict then refuses (part
03's G1, whose menu-item half is read there because the menu item beside forms first exists in pull
request 10).

**G5. Android renders a label with no markdown form as written** (pull request 9).
`gh workflow run proof-audit.yml --ref <branch> -f nightly=false -f slice='proof/android/test_form_reads.py
-k markdown' -f slice_readers=android`, after `test_a_label_without_markdown_renders_its_text_as_written`
is added over `targeted-plain-labels`.
- *Outcome A:* `*`, `#` and `1. ` show as typed: `label-with-no-markdown-form`'s Android reading "RUNS
  (literal)" holds and flips with it.
- *Outcome B:* Android renders them as markdown: the reading is corrected to DIFFERENT with the run as
  evidence, a platform cell is added, and part 04's plain-label property states it in its builder and
  guide sentence in pull request 9.

**G6. The identity moves, from each witness's evidence** (pull requests 2, 3, 4, 7, 9, 10 and 11, each
the one whose emission lands its witness's migration). Read `blocks/<id>/checks/proof1/corpus-<id>.json`
from the pull request's own lane run.
- *Outcome A:* proof 1's differences on the witness are exactly §5.2's expected moves: each is written
  into `proof/identity-moves.json` as `{"defect": <n>, "entity": <the difference's artifact glob>,
  "path": <its path>, "documents": [<witness id>]}`, and the lane passes.
- *Outcome B:* proof 1 shows a move §5.2 does not foresee: it is read against the migration's notice
  (part 09). A move the notice names is written with its defect as in outcome A; one it does not name is
  a defect of the migration (or of the emission), fixed in that pull request so the move does not
  happen, or, where the move is the migration's decided behavior, added to the notice by part 09 and
  then written.
- *Outcome C:* proof 1 shows none of an expected move: the expectation was wrong; nothing is written,
  and part 09's notice drops the deployment line that named it.

**G7. CI cost, measured** (pull request 15). `gh workflow run ci.yml --ref <branch> -f proof_fresh=true`.
- *Outcome A:* the dispatch's gate ends within the model's expected end plus the slot delays the README
  states; `proof/timings.json`'s `no-readers` profile and the README's timing numbers (documents,
  controls, groups, expected end) are written from it.
- *Outcome B:* it ends later because a step 5 document is heavy: the document's group cost is read from
  the run, the document is observed in pieces if it exceeds a shard's span (`proof/README.md`, "Documents
  observed in pieces"), and the README states the measured end.
- *Outcome C:* `plan fit` gives a thirteenth shard: `proof/README.md`'s timing rows and §8.2's table read
  13 shards in pull request 15, with the measured end, and §8.3's per-push numbers are restated from it.

**G8. The first night after the merge** (§8.5).
- *Outcome A:* the night passes; one pull request the next working day, with its own `/code-review
  medium`, holds only `proof/timings.json`'s `readers` profile and `proof/README.md`'s "Timings and what
  the lane is expected to take" numbers with every reader, written from that night's run. No row of part
  10 §11 reads timings, so the exit does not wait on it.
- *Outcome B:* it fails: its issue names each failing group and the command that reruns it, and each
  failing slice is fixed in its own pull request with its own `/code-review medium`, at the slice that
  command names, before part 10 §11's rows 1 and 2 are checked again (part 10's G4 outcome B); a served
  class showing on a document after its fix is G2's outcome B, landed by §2.6.

Gated runs other parts own and this part only hosts on the lane: decision 6's case list menu item run
(part 05's G1), the form-link order (part 06's G1), the held-case guard and the form settings save (part
06's G2 and G3), the CommCare Supply sensitivity and text runs (part 03's G1 and G2), the same-type flag
runs (part 03's G3 and G4), Core's order across placements, the per-row condition, the explicit preload's
save and `update_mode` (part 01's G1, G3, G4 and G5), the count placement's Vellum saves and Core's
reading (part 04's G1 and G2), the Case List save of each workflow and the Search screen with no visible
field (part 05's G3 and G4), every document whose search turns search first (part 05's G2, the same
dispatch as G2 and G3 here), the advanced JSON saves, the question named like an appended block, the
underscore worker property and the extension open action's owner (part 02's G2, G3, G4 and G6).

## Files by pull request

- **1**: `proof/checks/test_judge_purity.py` (`_cheapest_edited`), `proof/checks/registers.py`
  (`MOVE_KEYS`, `IdentityMove`, `load_identity_moves`, `accepted_moves`), `proof/checks/test_registers.py`,
  `proof/checks/test_proof1_identity.py`, `proof/checks/corpus.py` (`Document.migration_witness`,
  `verdict_lacks`), `proof/checks/cases.py` (`document_params`), `proof/checks/bar.py`, `intent.py`,
  `manifest_usage.py`, `proof/checks/controls.py` (`--migration-a`), `proof/checks/sensitivity.py`,
  `proof/checks/proof5.py` (docstrings naming `commtrackEnabled`), `proof/checks/test_corpus.py`, `test_sensitivity.py`,
  `test_proof5_locality.py`, `proof/store/queue.py`, `proof/store/test_queue.py`,
  `.github/workflows/proof-audit.yml` (`mechanics` description), `proof/corpus/publish.ts`
  (`retainedA`, the `commtrackEnabled` key, the placement record), `proof/corpus/targetPeer.ts`,
  `proof/corpus/entryWriter.ts`, `proof/corpus/inputs.ts`, `proof/corpus/emitCorpus.ts`,
  `proof/corpus/__tests__/publish.test.ts`, `emitCorpus.test.ts`, `proof/targeted/build.ts`
  (`migrationWitness`), `proof/targeted/documents/migrations.ts`, `proof/targeted/index.ts`,
  `proof/targeted/__tests__/targeted.test.ts`, `proof/hq/test_retained_reads.py`,
  `proof/migrations/<the eight>/` and `proof/hq-reads/<the eight>/` (second commit, G1),
  `scripts/lib/hqRoundTripCaseWrites/__tests__/fixtures/pre-step/<the eight>.json` (with part 09, whose
  capture test holds them in this pull request and whose digest test holds them from pull request 2),
  `proof/README.md`, `proof/CLAUDE.md`.
- **2**: `proof/known-defects.json` (271 to 192), `proof/fixed-defects.json` (746 to 825),
  `proof/checks/registers.py` (`OPEN_DEFECTS`), the capture sources of §4.2,
  `proof/native/core/CaseCaptureRuntimeTest.java`, `proof/native/producers/*`,
  `proof/targeted/__tests__/unproducedInputs.test.ts`, `proof/targeted/documents/migrations.ts`
  (the attachment witness), `proof/identity-moves.json` (G6), `proof/README.md` (row 23).
- **3**: the registers (192 to 87, 825 to 930), `OPEN_DEFECTS`, `sectionEntry.ts` and the count sources of
  §4.2, `lib/commcare/__tests__/xformDocArbitrary.ts`, `expressionDocArbitrary.ts`, `lib/doc/repeatCountWraps.ts`
  (part 04's), `proof/corpus/__tests__/fuzzSample.test.ts`, `proof/targeted/documents/repeats.ts`
  (`targeted-query-repeat-placements`, `targeted-repeat-count-whole`), `proof/targeted/index.ts`,
  `migrations.ts` (two witnesses), `proof/native/core/ContainerRuntimeTest.java`,
  `RepeatCountRuntimeTest.java`, `proof/native/families.py`, `proof/checks/test_corpus.py` (the census
  test), `lib/commcare/surface/entries/questions.json`, `proof/identity-moves.json`, `proof/README.md`
  (rows 25, 30; "The corpus").
- **4**: the registers (87 to 84, 930 to 933), `OPEN_DEFECTS`, the field-write sources of §4.2,
  `xformDocArbitrary.ts`, `suiteDocArbitrary.ts`, `lib/doc/fieldWriteOperations.ts` and
  `lib/doc/explicitPreloads.ts` (part 01's, with part 09's identity module), `fuzzSample.test.ts`,
  `proof/targeted/documents/loadTimeValues.ts`, `closeConditions.ts`, `caseWritesOneConcept.ts`,
  `proof/targeted/index.ts`, `migrations.ts`, `proof/checks/configurations.py`
  (`SAVE_ONLY_EDITED_FORM_FIELDS` grant), `proof/native/core/CaseOperationRuntimeTest.java`,
  `lib/commcare/surface/entries/forms-and-case-writes.json`, `gates.json`, `proof/README.md` (row 28).
- **5**: `proof/corpus/editKinds.ts` (`holdPlacements`), `proof/corpus/editBatches.ts` (the kernel
  rule's editor half), `proof/corpus/__tests__/editBatches.test.ts`,
  `proof/targeted/documents/heldPlacement.ts`, `proof/targeted/index.ts`.
- **6**: `proof/corpus/publish.ts`, `emitCorpus.ts` and `entryWriter.ts` (§4.5, with part 03: the first
  publish's capture moved ahead of edit planning and its record applied to D),
  `proof/corpus/__tests__/publish.test.ts`, `heldPlacement.ts` (holds from the record), `migrations.ts`
  (holds).
- **7**: the registers (84 to 58, 933 to 959), `OPEN_DEFECTS`, `extensionCaseFixture.ts`,
  `proof/targeted/documents/advancedModules.ts` (six documents), `proof/targeted/index.ts`,
  `migrations.ts`, `proof/native/core/CaseOperationRuntimeTest.java`, `AdvancedFormRuntimeTest.java`,
  `proof/native/test_advanced_emission.py`, `proof/native/families.py`, `proof/native/producers/*`,
  `proof/hq/test_advanced_rules.py` (reading part 02's `proof/hq/fixtures/advanced-rule-shapes.json`),
  `proof/checks/manifest_value_classes.py`, `test_manifest_value_classes.py`,
  `lib/commcare/surface/entries/menus-and-case-lists.json`, `forms-and-case-writes.json`, `gates.json`
  (G4), `proof/identity-moves.json`, `proof/README.md` (row 24, "Native proofs").
- **8**: `proof/corpus/publish.ts` (the predicates behind both keys, and the `flagsOff` key, with part
  03), `proof/checks/corpus.py` (`verdict_lacks` reads `flagsOff`), `proof/checks/sensitivity.py` and
  `proof5.py` (docstrings naming `flagsOff`), `test_sensitivity.py`, `test_proof5_locality.py`,
  `proof/corpus/__tests__/publish.test.ts`, `proof/checks/manifest_value_classes.py`
  (`own_case_type_where_same_type_unindexed`), `test_manifest_value_classes.py`,
  `proof/targeted/documents/sameTypeChild.ts`, `supplyPointText.ts`, `proof/targeted/index.ts`,
  `unproducedInputs.test.ts`, `gates.json` (part 03's G4), `proof/README.md` (row 12, "Configurations").
- **9**: the registers (58 to 55, 959 to 962), `OPEN_DEFECTS`, the labelled-group sources,
  `xformDocArbitrary.ts`, `lib/doc/groupFieldLists.ts` (with part 04), `fuzzSample.test.ts`,
  `proof/targeted/documents/formShapes.ts` (`targeted-field-list-flags`, `targeted-labelled-group-repeat`),
  `textReads.ts` (`targeted-plain-labels`), `proof/targeted/index.ts`, `migrations.ts`,
  `proof/android/test_form_reads.py`, `questions.json`, `proof/README.md` (row 27).
- **10**: the registers (55 to 18, 962 to 999, or as G3 outcome B), `OPEN_DEFECTS`, the search sources
  of §4.2, `suiteDocArbitrary.ts`, `lib/doc/searchWorkflowPlan.ts` (with part 05), `fuzzSample.test.ts`,
  `searchApps.ts`, `inlineSearchReads.ts`, `noMatchesReturnIdentity.ts`, `searchWorkflows.ts`
  (`targeted-search-workflow`, `targeted-search-workflow-inline`, `targeted-search-workflow-android`),
  `caseListMenuItems.ts` (`targeted-case-list-menu-item`), `advancedModules.ts`
  (`targeted-commtrack-advanced`), `proof/targeted/index.ts`,
  `migrations.ts`, `proof/views/test_search_workflow_offers.py`, `proof/walk-stops.json` (G2),
  `case-search.json`, `menus-and-case-lists.json`, `gates.json` (G4's menu item effect),
  `proof/README.md` (row 21, "Walk stops").
- **11**: the registers (18 to 0, 999 to 1,017), `OPEN_DEFECTS` (`{}`), `test_registers.py` (docstring,
  `step > 5`), the form-link sources and `expander.test.ts`, `formLinkWireFixture.ts` (with part 06),
  `formLinksHiddenFallback.ts`, `instanceReads.ts`, `inlineSearchReads.ts`,
  `formLinkChain.ts`, `formLinkCarriedCase.ts`, `formLinkOtherwise.ts`, `proof/targeted/index.ts`,
  `migrations.ts`, `proof/corpus/editKinds.ts` (`setFormOtherwise`), `footprint.ts`,
  `editBatches.test.ts`, `proof/native/core/FormLinkRuntimeTest.java`,
  `proof/native/producers/emit-form-link-evidence.ts`, `proof/native/test_navigation_emission.py`,
  `proof/views/test_form_link_targets.py` (reading part 06's `lib/commcare/__tests__/fixtures/formLinkTargets.json`,
  which its `lib/commcare/__tests__/formLinkTargets.test.ts` writes),
  `manifest_value_classes.py`, `forms-and-case-writes.json`, `proof/README.md` (row 26, "Known
  defects"), `proof/CLAUDE.md`, `harness-findings.md` (§9.3).
- **12, 13, 14**: none of this part's own.
- **15**: `proof/timings.json` (`no-readers`, G7), the README tables that count documents, controls and
  groups.
- **16**: none of this part's own; part 09 removes the pre-step fixtures with the tooling, and the
  witnesses, their retained A and HQ's reads stay.

## Departures

- **Identity moves are no longer empty by design** (`proof/README.md`, "Identity moves"): each is scoped
  to its migration witnesses, which is the only way the exit's "a republish after each migration" is
  observed rather than argued.
- **The cutover's `fixtures/pre-step-hq/` are `proof/hq-reads/<witness id>/app-source.json`** (the
  cutover brief's layout): HQ's reads are retained where every HQ read Nova's tests serve is
  (`proof/hq/test_retained_reads.py`), held byte for byte at every pin, and they outlive the tooling for
  step 6's import, which reads them through part 03's `publishedCaseBlocks`.
- **The cutover's republished corpus documents are the eight witnesses** (the cutover brief asked one per
  pre-step fixture): a witness per migration that changes the wire or an identity; the cutover's other
  pre-step fixtures stay pure tests of its planner.
- **Proof's G5 (what a count-placement row keeps when the results change) is not a separate run**:
  part 04's design keeps a row's answers at its position and its notice says so, and
  `ContainerRuntimeTest` asserts that design in part 04's G2.
- **The CommCare Supply witness `targeted-commtrack-advanced` lands in pull request 10, not 8**: an
  advanced module's case list menu item beside forms exists only from `Module.caseListMenuItem` (defect
  29, pull request 10); pull request 7 writes the effect every advanced module shows, and pull request
  8's predicate reads the menu item where a module holds one, with a Vitest witness for its advanced arm
  until pull request 10.
- **The verdict gains `flagsOff`** in pull request 8, beside the decisions' `commtrackEnabled` of pull
  request 1, for `DONT_INDEX_SAME_CASETYPE` (decision 8's `featureFlagsOff`), by the same mechanism.
- **The proof brief's `targeted-markdown-preloads` is split**: its preload half joins
  `targeted-case-writes-one-concept` (pull request 4) and its plain-label half is `targeted-plain-labels`
  (pull request 9), so each lands with the change it witnesses.
- **A run started by hand may name a control** (§1.5), which the briefs' runs assumed and the queue did
  not allow.
- **The fuzz generators draw no new shape**, where part 02's and part 06's briefs asked them to draw
  advanced modules and new link shapes: the proof sample keeps its draws, and those draws go to Vitest
  arbitraries of their own.
- **No step 5 pull request leaves a live entry** (§2.6), where three briefs' outcome B registered one.
- **The case-writes witness's two close conditions are on close forms Close and Close in repeat**
  (§5.2 item 2), where the plan put both on the follow-up Visit: `main`'s gate admits a close condition
  only on a close form, one per form (`lib/commcare/validator/rules/form.ts::closeConditionValidation`),
  so Visit keeps its writes and operations and each condition is its own close form's.
- **The form-links witness is declared Web Apps** (§5.1, §5.2 item 6), where the plan declared both:
  its several-case menu Batch is unavailable on Android, and `main`'s gate refuses a feature an app's
  platforms cannot run (`lib/commcare/validator/rules/platforms.ts::platformFeatureAvailability`,
  `several-cases` in `lib/domain/platforms.ts`), as for the case-writes witness's several-case menu.
- **Pull request 1's placement record is applied by nothing** (§1.3), where the plan had
  `emitCorpus.ts` apply the empty list to D: at `main` the corpus plans D′ before the first publish's
  capture runs, so pull request 6 moves that capture ahead of edit planning in `emitCorpus.ts` and
  `entryWriter.ts` and applies the record there (§4.5).
- **`container-nested-query` holds 28 defect 25 entries and `container-query-conditional-relative` 2**
  (read), where the proof brief's grouping said 27 and 3.

## What other parts read from this one

- **Every part**: the targeted documents' names (§5.1) and that no step 5 pull request leaves a live entry
  (§2.6), which is how each part's outcome B lands on the registers.
- **Part 01**: the moves of defects 23 and 28 (§2.3) in pull requests 2 and 4; `targeted-case-writes-one-concept`
  and `targeted-held-placement` as this part writes them (the first holding what its
  `targeted-registration-closes` held, the second its `targeted-placement-held`); the case-writes
  witness's close operation, which `CASE_OPERATION_CLOSES_OWN_CASE` refuses at the head from pull request
  4 (§5.2); `lib/doc/fieldWriteOperations.ts::operationsFromFieldWrites`
  and `lib/doc/explicitPreloads.ts::planExplicitPreloads` as pure, deterministic planners over a draw's
  facts, kept past pull request 16; the `holdPlacements` generator's need for `withIdentityMoves`; that the
  operation's and the own close's held slot is stored from pull request 4, so the case-writes witness holds
  what the cutover writes (§5.2).
- **Part 02**: the moves of defect 24 in pull request 7; §7.1's advanced flips and §7.2's readers;
  `targeted-advanced-module`, `targeted-extension-carried`, `targeted-advanced-child-module`,
  `targeted-advanced-held-kind`, `targeted-root-case-block-names`, `targeted-worker-underscore-write`
  (pull request 7) and `targeted-commtrack-advanced` (pull request 10); G4; that its G3 and G4 are read on
  their documents, and `targeted-worker-underscore-write` leaves under G4's outcome B; the native class
  `AdvancedFormRuntimeTest` and `test_advanced_emission.py`; `test_advanced_rules.py` over its fixture;
  that `loadupdateaction-preload-question-property` stays HELD-NEW; that the proof sample's generators
  draw no advanced module.
- **Part 03**: the verdict keys `commtrackEnabled` (pull request 1) and `flagsOff` (pull request 8) and
  their readers, whose missing-configuration words are "CommCare Supply off" and "<flag> off" (§1.4);
  the capture's record hook and §4.5; the corpus judging each batch by the kernel rule from pull request
  5 (§4.4); `targeted-same-type-child` with its two forms, `targeted-supply-point-text`,
  `targeted-commtrack-advanced` (pull request 10); the reader of the same-type value class (§7.2); that
  its G1 sensitivity run is read in pull requests 7 and 10 (G4) and its G4 in pull request 8.
- **Part 04**: the moves of defects 25, 30 and 27 (pull requests 3 and 9); the four documents
  `targeted-query-repeat-placements`, `targeted-repeat-count-whole`, `targeted-field-list-flags`,
  `targeted-plain-labels` (the last two taking in its `targeted-field-lists` and the plain-label half of
  `targeted-markdown-preloads`, and `targeted-repeat-count-whole` its `targeted-repeat-count-integers`);
  `targeted-migration-query-repeats`' expected moves as part 04 gives them; G5 (the Android plain-label
  run) for the plain-label sentence; `lib/doc/repeatCountWraps.ts::planRepeatCountWraps` and
  `lib/doc/groupFieldLists.ts::planGroupFieldLists` as pure planners the fuzz mapping calls; its G1 and
  G3 as §8.4's rows 3 and 9; `ContainerRuntimeTest`'s by-position assertion.
- **Part 05**: the move of defect 21 and G3's two outcomes for the expander entry; its four search
  documents by its own names and `targeted-commtrack-advanced`, read in decision 6's run; §8.4's row 10
  as the one dispatch of its G1, G2 and G4; the corpus sources and the fuzz mapping writing
  `skipToResults` for a search with no visible input (M1's last row) through
  `lib/doc/searchWorkflowPlan.ts::authoredSearchWorkflow`; `proof/views/test_search_workflow_offers.py`.
- **Part 06**: the move of defect 26, the order constraint that keeps the expander document's title; the
  three form-link documents, which replace `targeted-form-link-semantics` with its content split between
  `targeted-form-link-chain` (with the reorder D′) and `targeted-form-link-otherwise`; the three new
  producer documents of its wire fixture; the `setFormOtherwise` generator; `FormLinkRuntimeTest`'s
  renamed method and scenarios; `proof/views/test_form_link_targets.py` and its fixture; the walk rule
  for `this-form` (§3); that the proof sample's generators draw no new link shape.
- **Part 07**: no document of its own; the identity-move statements it shows are the shapes of
  `targeted-held-placement`, `targeted-advanced-held-kind` and the witnesses.
- **Part 09**: the eight witnesses, their pre-step documents as its pre-step fixtures (pull request 1,
  under its capture test there and its digest test from pull request 2), HQ's reads of them in place of
  `fixtures/pre-step-hq/`, G1's outcome B, and G6's moves, which its notice must name; the case-writes
  witness's close operation as C9's lane evidence beside its `pre-step-own-close-operation` fixture; the
  planner test `planner(pre-step document) = witness spec`; the five planners of §4.3 by their owners'
  names.
- **Part 10**: the stack's order constraints (§2.2), every pull request's lane row (§8.2), the push costs
  (§8.3), pull request 1 settled before the cut, the runs by hand (§8.4), the first night (§8.5), and the
  exit counts: known 0, fixed 1,017, `OPEN_DEFECTS` `{}`, 25 walk stops or as G2 leaves them, 108
  controls, eight witnesses, thirty targeted documents by pull request (1: 8, 3: 2, 4: 1, 5: 1, 7: 6,
  8: 2, 9: 2, 10: 5, 11: 3) and part 06's three producer documents, a corpus of 431; under part 02's
  G4 outcome B, twenty-nine (7: 5) and a corpus of 430.
- **For the outlines.** Step 6: the witnesses' retained HQ reads (`proof/hq-reads/targeted-migration-*`)
  are the evidence its import's placement reader is proven over, kept for that reason. Step 7: the manifest
  entries §7.1 leaves HELD-NEW (an advanced load's preload, the auto-select modes, the usercase list module, a relationship chosen per
  submission, a label as a write source, computed datums, the case-list-form arms, several address columns,
  the cross-tab tile row) flip with their readers when step 7 emits them, because no step 5 shape emits
  them; and step 7 adds a fuzz family drawing advanced modules and the new link shapes, with its own
  sample, because the existing sample keeps its draws.

## Appendix: every known entry and its control

Each moves to `proof/fixed-defects.json` on the control shown, with `document` dropped, in the pull
request §2.3 names. Ids are grouped by document and control; `*` stands for the suffixes listed.

**Defect 21 (pull request 10).**
- `targeted-list-first-web-apps` → same (27): `d21-search-first-app-search-config-auto-launch`,
  `d21-search-first-blocks-{c660,d0d9,fb79,refusal}`, `d21-search-first-suite-action-auto-launch`,
  `d21-search-first-trace-{7431,a9f0,autolaunched,badges,casedetail,choices,chosen,defaultsearch,events,hidden,prompts,root,screen,script,stackaftersubmit,title,unreplayable-638a,unreplayable-ec6d,xmlns}`,
  `d21-list-first-turned-search-fir-formplayer-case-list-response-type`,
  `d21-list-first-turned-search-fir-webapps-case-list-screens-kind`.
- `targeted-list-first-places` → same (3): `d21-list-first-turned-search-fir-webapps-case-list-{runs,runs-viewport,runs-viewport-removed}`.
- `case-list-match-none` → same: `d21-list-first-turned-search-fir-trace-case-list-end-no-cases-script-ended`.
- `case-list-no-details` → `case-operation-query`: `d21-list-first-turned-search-fir-trace-case-list-end-empty-menu-unreplayable`.
- `targeted-search-related-lookups` → `case-operation-query`: `d21-list-first-turned-search-fir-trace-case-list-trace`.
- `tile-grouped-search` → same: `d21-list-first-turned-search-fir-trace-case-list-trace-{datum,step}`.
- `targeted-sync-on-form-entry-web-apps` → `targeted-sync-on-form-entry`: `d21-list-first-turned-search-fir-trace-case-list-trace-requests`.
- `expander-form-links-emission-forwards-literal-condition-47c96355-0` → same: `d21-list-first-turned-search-fir-formplayer-case-list-submit-nextscreen-type` (G3).

**Defect 23 (pull request 2).**
- `case-capture-multiple` → `case-capture-multiple-after-3` (intent): `d23-attachment-data-dictionary-attachment-under-save-to-case`,
  `d23-attachment-form-case-updates-attachment-under-save-to-case`.
- `case-capture-followup` → same (manifest): `d23-attachment-app-upload-question`,
  `d23-attachment-app-schema-form-actions-upload-question`,
  `d23-attachment-app-schema-formactions-update-case-upload-question`,
  `d23-attachment-app-schema-updatecaseaction-update-upload-question`.
- `case-extension-multiple` → `case-extension-registration-after-13` (manifest):
  `d23-attachment-form-instance-attachment-in-a-savetocase-block`.
- `case-capture-registration` → `case-capture-followup`: `d23-attachment-vellum-mug-caseproperty-error-case-property-not`,
  `d23-attachment-vellum-again-mug-caseproperty-error-case-property-not`.
- `case-capture-multiple` → `case-capture-multiple-after-13`: `d23-attachment-blocks-case-attachment-cecc`,
  `d23-attachment-form-attachment-src-22fa`, `d23-attachment-form-case-attachment-{0e43,bc0c}`,
  `d23-attachment-mode-capture-formplayer-vellum-nova-update-selected-cases-case-attachment` and `-2`,
  `d23-attachment-source-attachment-src-7142`, `d23-attachment-source-case-attachment-{a320,c3f8}`,
  `d23-attachment-trace-case-attachment-754d`, `d23-attachment-vellum-parse-warning-bind-node-found-77d6`,
  `d23-attachment-vellum-parse-warning-src-bind-node-found-f1af`.
- `case-extension-multiple` → `case-extension-multiple-after-13`: `-blocks-case-attachment-ed9e`,
  `-form-attachment-src-ba58`, `-form-case-attachment-{279b,d8bd}`,
  `d23-attachment-mode-capture-formplayer-vellum-nova-subcase-case-attachment-{2,5}`,
  `-source-attachment-src-6212`, `-source-case-attachment-{d4ab,f87e}`, `-trace-case-attachment-12d3`,
  `-vellum-parse-warning-bind-node-found-d238`, `-vellum-parse-warning-src-bind-node-found-a8b1`
  (each `d23-attachment` prefixed).
- `case-extension-multiple-repeat` → `case-extension-multiple-repeat-after-13`: `-blocks-case-attachment-4a7a`,
  `-form-attachment-src-83fc`, `-form-case-attachment-{dbdd,f59e}`, `...-nova-subcase-case-attachment-7`,
  `-source-attachment-src-448f`, `-source-case-attachment-{4bb5,8a61}`, `-trace-case-attachment-2e20`,
  `-vellum-parse-warning-bind-node-found-acca`, `-vellum-parse-warning-src-bind-node-found-b0f8`.
- `case-extension-query` → `case-extension-query-after-13`: `-blocks-case-attachment-58ea`,
  `-form-attachment-src-f439`, `-form-case-attachment-{1b28,66c7}`, `...-nova-subcase-case-attachment` and
  `-4`, `-source-attachment-src-8062`, `-source-case-attachment-{7bc4,a963}`, `-trace-case-attachment-fe72`,
  `-vellum-parse-warning-bind-node-found-c2f2`, `-vellum-parse-warning-src-bind-node-found-df1e`.
- `case-extension-registration` → `case-extension-registration-after-13`: `-blocks-case-attachment-ad85`,
  `-form-attachment-src-b973`, `-form-case-attachment-{039a,ce28}`, `...-nova-subcase-case-attachment-{3,6}`,
  `-source-attachment-src-9edd`, `-source-case-attachment-{f004,faa4}`, `-trace-case-attachment-15fb`,
  `-vellum-parse-warning-bind-node-found-b420`, `-vellum-parse-warning-src-bind-node-found-cf4b`.
- `case-extension-repeat` → `case-extension-repeat-after-13`: `-blocks-case-attachment-ce57`,
  `-form-attachment-src-c0c7`, `-form-case-attachment-{413a,8d7e}`, `...-nova-subcase-case-attachment-8`,
  `-source-attachment-src-7ee7`, `-source-case-attachment-{46c4,717e}`, `-trace-case-attachment-5f0c`,
  `-vellum-parse-warning-bind-node-found-eba6`, `-vellum-parse-warning-src-bind-node-found-e37c`.

**Defect 24 (pull request 7).**
- `case-extension-multiple` → `case-extension-registration-after-13` (manifest):
  `d24-inert-subcase-app-schema-form-actions-{extension,subcase-never}`,
  `d24-inert-subcase-app-schema-formactions-subcases-{extension,subcase-never}`,
  `d24-inert-subcase-app-schema-opensubcaseaction-condition-subcase-never`,
  `d24-inert-subcase-app-schema-opensubcaseaction-relationship-extension`.
- `case-extension-repeat` → `case-extension-registration-after-13`: `d24-inert-subcase-app-subcases-relationship`.
- `case-extension-query` → `case-extension-query-after-13`: `d24-inert-subcase-blocks-{cases,item-case-added,item-subcase-case-removed}`,
  `d24-inert-subcase-formplayer-local-ccz-item-id-{case,subcase}`, `d24-inert-subcase-trace-item-{case,subcase}`;
  → `case-extension-query-after-59`: `d24-inert-subcase-formplayer-local-ccz-submissions-item-{case,subcase}-unpaired`.
- `case-extension-registration` → `case-extension-registration-after-13`: `d24-inert-subcase-formplayer-local-ccz-output-data-subcase`,
  `d24-inert-subcase-trace-subcase-50ea`; → `-after-59`: `d24-inert-subcase-formplayer-local-ccz-submissions-subcase`.
- `case-extension-repeat` → `case-extension-repeat-after-13`: `d24-inert-subcase-blocks-{case-added,subcase-case-removed}`,
  `d24-inert-subcase-trace-{case,casedb-case,subcase-c90a}`; → `-after-59`:
  `d24-inert-subcase-formplayer-local-ccz-submissions-{case,subcase}-unpaired`.

**Defect 25 (pull request 3).**
- `container-nested-query` → same (manifest): `d25-query-repeat-form-vellum-role-model-iteration-nested`.
- `container-query-conditional-parent` → same (manifest): `d25-query-repeat-form-vellum-role-model-iteration-under-late-relevance`.
- `case-operation-query` → same: `d25-query-repeat-form-{bind-nodeset-count,current-index-calculate,setvalue-event-xforms-ready-ref-count}`,
  `d25-query-repeat-source-{bind-nodeset-count,current-index-calculate,setvalue-event-xforms-ready-ref-count}`,
  `d25-query-repeat-vellum-parse-warning-count-bind-node-found`.
- `container-nested-query` → same (proof 4, 27): `d25-android-proof4-vellum-form-{ended-changed,finishshown-removed,path-changed}`,
  `d25-android-proof4-vellum-form-saved-{aftersend-removed,casesastheformopened-added,finishing-changed,records-removed,resultcode-removed}`,
  `d25-android-proof4-vellum-menuactivity-formentryactivity-formentryactivity-error-occurred-changed`,
  `d25-query-repeat-blocks-{8b0f,c293,d47a,refusal}`, `d25-query-repeat-form-setvalue-event-jr-insert-ref-count`,
  `d25-query-repeat-source-setvalue-event-jr-insert-ref-count`,
  `d25-query-repeat-rewritten-into--formplayer-vellum-response-type`,
  `d25-query-repeat-rewritten-into--webapps-vellum-{alerts,run-ends-answers,run-ends-screens,run-ends-submit,screens-kind}`,
  `d25-query-repeat-trace-{events,stackaftersubmit}`,
  `d25-query-repeat-trace-org-javarosa-xpath-expr-xpathselectedatfunc-selectedat-xpathselectedatfunc-java-40-{3617,7a32,c273,e9e6}`.
- `container-query-conditional` → `container-query-conditional-after-13` (62):
  `d25-saved-query-repeat-formplayer-runs-steps-{answers-added,answers-ix-changed,answers-status-changed,answers-type-changed,answers-value-changed,asked-added,asked-changed,resent-added,resent-after-changed,response-instancexml-output-data-current-index-changed,response-instancexml-output-data-item-id-added,submissions-instance-data-added,submitted-answers-1-0-0-added,submitted-answers-1-1-0-added}`,
  `d25-saved-query-repeat-formplayer-runs-steps-response-tree-{added,binding-changed,caption-changed,caption-markdown-changed,children-added,control-changed,datatype-changed,exists-changed,ix-changed,question-id-changed,repeatable-changed,style-changed,type-changed}`,
  `d25-saved-query-repeat-formplayer-runs-steps-tree-{added,binding-changed,caption-changed,caption-markdown-changed,children-added,control-changed,datatype-changed,exists-changed,ix-changed,question-id-changed,repeatable-changed,style-changed,type-changed}`,
  `d25-saved-query-repeat-html-head-model-bind-nodeset-data-removed`,
  `d25-saved-query-repeat-runs-trace-events-{added,attempts-removed,audio-removed,control-removed,datapath-removed,datatype-removed,event-changed,help-removed,hint-removed,image-removed,path-changed,readonly-removed,required-removed,text-changed,unanswerable-removed,valuesfrom-removed}`,
  `d25-saved-query-repeat-webapps-runs-{answers-added,screens-form-groups-added,screens-form-questions-added,screens-form-questions-answer-changed,screens-form-questions-label-changed}`.
- `container-query-conditional-relative` → `container-query-conditional`: `d25-query-repeat-source-bind-nodeset`,
  `d25-query-repeat-vellum-parse-warning-bind-node-found`.
- `targeted-query-repeat-places` → same: `d25-query-repeat-rewritten-into--formplayer-vellum-data-count`.

**Defect 26 (pull request 11).**
- `targeted-form-links-hidden-and-fallback` → same: `d26-form-links-app-{form-links-other-module-target,module-unique-id-other-module-target,not-offered-under-conditional-link}`
  (manifest); `d26-form-links-app-{form-links,post-form-workflow-fallback}`, `d26-form-links-suite-stack-create`,
  `d26-form-links-trace-{stackaftersubmit-nextframeready,stackaftersubmit-steps,steps-type}`,
  `d26-form-links-webapps-form-settings-{breadcrumbs,commands,commands-icon,commands-text,route-selections,title}`,
  `d26-hidden-links-and-navigation--formplayer-form-settings-submit-nextscreen`.
- `expander-form-links-emission-forwards-literal-condition-47c96355-0` → same:
  `d26-a-link-names-no-case-soft-assert-casedb-base-get-case-from-case-update` (proof 4),
  `d26-a-link-names-no-case-soft-assert-proof3-casedb-base-get-case-from-case-update` (proof 3).

**Defect 27 (pull request 9).** `targeted-labelled-group-repeat` → same:
`d27-labelled-group-repeat-form-xform-repeat-user-repeat-in-a-field-list`,
`d27-labelled-group-repeat-vellum-mug-repeat-count-error-repeat-count-required`,
`d27-labelled-group-repeat-vellum-again-mug-repeat-count-error-repeat-count-required`.

**Defect 28 (pull request 4).** `targeted-load-time-values` → same:
`d28-load-time-values-app-form-actions`, `d28-load-time-values-app-formactions-case-preload`,
`d28-load-time-values-app-preloadaction-preload`.

**Defect 30 (pull request 3).** `targeted-repeat-count-copy` → same: `d30-repeat-count-evaluate`;
`container-live-count-entry` → same: `d30-repeat-count-form-count-from-non-integer-hidden-value-{7b4f,f24f}`,
`d30-repeat-count-form-mug-repeat-count-from-non-integer-hidden-value`.
