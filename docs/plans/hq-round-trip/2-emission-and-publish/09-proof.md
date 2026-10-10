# Step 2, part 09: Proving the fixes on the lane

Part of [step 2's plan](../2-emission-and-publish.md), which holds the baseline, the decisions, the stack and the exit. Citations are `file::symbol`; HQ paths are relative to `corehq/apps/app_manager` unless another app is named.

Step 1 left the proof lane (`proof/README.md`), its strict register
(`proof/known-defects.json`, 613 entries), 67 control directories of which the
register names 66, 33 spelling rules (`proof/rules/__init__.py::RULES`) and an
empty `proof/identity-moves.json`. Step 2 empties 454 of those entries. This
section says how each fix is proven, how a fixed defect's control keeps
running, and what the lane itself must change so that it keeps publishing as
Nova publishes.

Pull request numbers below are the positions in the table of part 11, The
stack: 1 lane mechanics, 2 cutover
skeleton, 3 identity and the publish sequence, 4 drift, 5 app-level emission,
6 XForm first part, 7 XForm second part, 8 defect 3 and work item H's
closure, 9 case writes through basic actions, 10 identifiers and form
content, 11 case lists, 12 menus, navigation and search settings, 13 publish
gates, 14 lookup, CSQL, media and the model clean-up, 15 contracts and docs,
16 removal of the cutover tooling.

Four rules bind every pull request of the stack:

- **Green at its own head.** Each pull request passes the whole lane at its
  own head, not only on its own documents: removing one fix's entries can
  leave another entry redundant (`proof/checks/registers.py::reconcile`
  refuses an entry every one of whose differences another entry holds).
- **Entries move with the fix.** A fix moves its entries from
  `proof/known-defects.json` to `proof/fixed-defects.json` and retires its
  spelling rule in the same pull request.
- **A control is retained before its fix.** After a fix merges Nova no longer
  emits the bytes, so every control the step needs exists before the fix's
  pull request. Pull request 1 retains three (work item H's, finding 56's
  and finding 57's), pull request 5 retains `connect-location-capture` in
  its first commit, before any judge or emitter change, and pull request 7
  retains the six `-after-13`. Two more are retained only where a run calls
  for them: `container-query-conditional-after-13` in pull request 6 (part
  05, Shadows (defect 13) with findings 45 and 47: no `#case/` shadow) and
  `targeted-custom-tile-explicit-cells` in pull request 11 (part 07, Tile
  cells and finding 42).
- **Paths come from evidence.** A path that moves is read from the run's
  evidence file (`blocks/<id>/checks/<check>/corpus-<id>.json`), never
  produced by substituting text in the old one.

## The register and the findings this section owns

### The fixed-defect register and finding 52's orphaned control

**Today.** A check runs on a control only while a known-defect entry of that
check names it (`proof/checks/cases.py::control_params`), and a `control:<id>`
group is queued only while an entry names it
(`proof/store/queue.py::control_groups`). Removing a defect's entries
therefore stops its control everywhere, silently: #712 removed finding 52's
two entries, and
`proof/controls/expander-form-hashtag-expansion-declares-the-casedb-02e7ce76-0`
has run nowhere since. Nothing in the lane notices a control directory no
entry names.

**Fix.** A second register, `proof/fixed-defects.json`: a JSON list, `[]` when
empty, required to exist.

An entry is a known-defect entry without `document`, carrying the id it had:

```json
{"id": "d1-ids-app-xmlns", "defect": 1, "part": "ids and xmlns",
 "check": "proof1", "artifact": "app.json", "path": "/modules/*/forms/*/xmlns",
 "control": "case-operation-query"}
```

with `kind`, `values`, `android` and `equivalence` where the live entry had
them. There is no `fixed` field: a stack's pull request number is unknown when
the entry is written, and git holds it.

Rules, enforced by the loader and the gate:

1. The same field checks as a live entry: `check` in
   `registers.py::HELD_CHECKS`, `path` from the root, `kind` one of
   `proof/checks/differences.py::KINDS`, no undecided manifest use, and the
   control directory exists.
2. An id is in one register only. No two fixed entries share check, artifact,
   path, kind, values and control.
3. A fixed entry is held on its control alone, by every run, sampled or whole:
   the check ran on the control and some difference there matches the entry
   (its class, and `values` where pinned, compared without a document).
4. A fixed entry is never an owner on a corpus document. `reconcile` already
   fails any corpus difference no live entry holds, so a regression into a
   fixed class fails as unregistered. The fixed register is read on corpus
   documents for one thing: the failure message. Where an unregistered
   difference falls in a fixed entry's class,
   `registers.py::Reconciliation.explain` adds "this is the class of fixed
   defect N (`<entry id>`): the defect is back, or this is a new symptom in
   the same class."
5. Every directory under `proof/controls/` is named by an entry of one of the
   two registers.
6. A directory a fixed entry names is never retained again
   (`proof/checks/controls.py::retain` removes the directory before it
   writes). A remaining defect whose symptom moves on such a document gets a
   new control under a new directory name.
7. `values` on a fixed entry needs no targeted document: it has none.
8. The repair rule (below).

There is deliberately no rule "a fixed entry matches nothing on any corpus
document". Classes are coarse (`case_blocks@vellum@*` `/runs/*/cases/*`,
`trace@local.ccz` `.../case_name[*]/text()`), so a later, different defect
registered live in the same class would fail the lane on a difference the
register holds. Where a live and a fixed entry share check, path and an
overlapping artifact, the gate prints a note, never a failure: a live entry in
a fixed class would absorb that class's regression on every document. No
remaining entry shares a class with a step 2 entry. Inside the stack the note
is expected, and is no fault, in two places: for defect 12's five custom-tile
entries against defect 14's fixed tile entries on the same paths (they differ
by the `@CASE_LIST_TILE` artifact suffix and by kind) at pull requests 11 and
12, and for the values-pinned `admission@*` entry of defect 15 against
defect 14's fixed one at pull request 9. None prints from pull request 13 on.

Why this design, and not the three others considered:

| Design | Why not |
|---|---|
| A `fixed` marker on entries kept in `known-defects.json` | `reconcile` would have to skip marked entries on corpus documents or hold a regression with the entry meant to catch it, and the exit ("the register holds no entry for defects ...") could not be read from the file. |
| An expectations file inside each control directory | It would be an input file of the control (`proof/observe/unit.py::input_files` reads the directory), so editing a judge input would re-key the observation. |
| Drop a fixed defect's control and rely on each check's planted-failure tests | It abandons step 1's decision 12: the retained pre-fix input is the only thing that catches a fix pull request that also changes a comparator, a rule or `proof/checks/compare/names.py` so that the check goes blind. |
| Keep the observation records, or a golden of each control's whole evidence | Records alone drop the half the control exists for (an observation or driver change that blinds a check). A golden pins every difference a control shows that no entry names, which `cases.py::hold` deliberately ignores, and a regenerate command becomes a rubber stamp. |

What the fixed register costs, stated so later steps expect it: a fixed entry
pins the judge's vocabulary to the pre-fix bytes for as long as it lives.

- `proof/checks/compare/names.py` keeps reading the `__nova_` names
  (`NOVA_CONTAINERS`, `NOVA_MINTED`) literally, for the 143 fixed defect 13
  paths that hold one (defect 23's 60 are re-pathed in pull request 7), and
  `proof/checks/manifest_value_classes.py::nova_scaffolding_part` likewise.
  The new `nova_` names are read as part 05, The one allocator, specifies;
  `nova_count_<repeat>` and `nova_constraint_message_<question>` stay `*`.
- 65 fixed manifest entries pin REFUSED value-class names of
  `lib/commcare/surface/entries/*.json`.
- The observation replays the legacy capture layout beside the new one, and a
  control's `derived.json` is read without the `Intent` fields step 2 adds
  ("How the harness keeps publishing as Nova publishes").
- Paths hold upstream text (Vellum messages, HQ `file::function` names, Java
  frames), so a pin move can break a fixed entry that has no document to fall
  back on.

**The repair rule.** A fixed entry is repaired in exactly two ways, each named
in its pull request with the citation:

| What happened | Repair |
|---|---|
| The check's vocabulary or the pinned upstream text moved (a renamed Vellum message, a moved HQ function, a renamed value class) and the control shows the same symptom at a new path | Re-path the entry from the control's evidence. |
| Upstream changed the behavior so the pre-fix bytes are no longer a symptom, or a judge change deliberately stops reporting the class | Delete the entry, and the control directory when no other entry names it. |

A fixed entry is never loosened, never widened to a pattern, and its control
is never retained again. A fixed entry that stops showing for any other
reason is the regression in the harness the control exists to catch. The
weekly pin pull request's prewarm observes every control fresh
(`proof/README.md`, "Changing a pin"), so both repairs surface there and are
committed to that branch before it merges.

**Files.**

- Lane, judges:
  - `proof/fixed-defects.json` (new).
  - `proof/checks/registers.py`: `Entry.document` becomes `str | None`; in
    `Entry.matches` the pinned-values arm becomes
    `(self.document is None or difference.document == self.document)` and the
    two values equal. New `FIXED_DEFECTS` and `fixed_defects_path()`: when
    `PROOF_KNOWN_DEFECTS` names a register, the fixed one is
    `fixed-defects.json` beside it, read as empty when absent, so
    `proof/lane/test_gate.py` and `proof/lane/test_forkserver.py`, which
    write only a `known-defects.json` into a temporary directory, keep working
    with no second environment variable. New
    `load_fixed_defects(path=None, *, known=(), controls=CONTROLS)` applying
    rules 1 and 2. `verify_evidence(directories, entries, *, fixed=(),
    unsampled=frozenset())` reports for each fixed entry the two control
    problems it already reports for a live entry (no evidence, no match).
    `reconcile(..., fixed=())` only labels unregistered differences. `main`
    loads both. The module docstring says "three registers".
  - `proof/checks/cases.py`: `load_fixed()` (cached); `control_params(check)`
    takes the controls live or fixed entries of that check name; `hold` on a
    control (`document.kind == "control"`) adds `load_fixed()` to its owners
    itself, so the ten test modules that call it (`test_bar.py`,
    `test_intent.py`, `test_manifest.py`, `test_proof1_identity.py`,
    `test_proof2_build.py`, `test_proof3_behavior.py`,
    `test_proof4_editability.py`, `test_proof5_locality.py`,
    `test_sensitivity.py`, `test_registers.py`) keep passing
    `cases.load_register()`.
  - `proof/checks/controls.py::main` and `::retain`: a control name argument
    beside the existing optional controls directory,
    `python3 -m proof.checks.controls <corpus> <document id> <checks> [<into>] [--as <control name>]`.
    `retain(document, checks, into, *, name=None)` writes
    `into/<name or document.id>` and refuses a `name` that a fixed entry's
    `control` names (rule 6).
- Lane, observation partition (each change re-keys every record once):
  - `proof/store/queue.py::control_groups(known_defects, controls,
    fixed_defects=None)` unions the `control` fields of both files, and
    `::main_groups` passes `proof_dir / "fixed-defects.json"`. Standard
    library only, as today.
  - `proof/lane/gate.py::gate`: `fixed = registers.load_fixed_defects(known=entries)`,
    `verify_evidence(..., fixed=fixed, unsampled=unsampled)`; its register
    section says how many fixed entries it held on their controls and prints
    the shared-class note. It stays on Python 3.12's standard library.
  - `proof/store/fingerprints.py`: `JUDGE_FILES` gains
    `"proof/fixed-defects.json"`, with the docstring's judge paragraph.
    `proof/store/conftest.py`'s fixture tree gains the file.
- Tests: below.
- Docs: `proof/README.md` and `proof/CLAUDE.md` ("What the two documents say
  when step 2 ships"). `proof/timings.json` gains the control group.

Unchanged: the evidence layout, part keys, queue keys,
`Reconciliation.holds`, and the sampled-run rule.

**Stored shape and migration.** none: the lane holds no Nova Postgres state.

**Register.** Finding 52's two classes return as the first two fixed entries,
with the ids they had: `d52-output-in-validation-form-alert` (artifact
`form:*@vellum@*`) and `d52-output-in-validation-source-alert` (artifact
`source:form:*@vellum@*`), both defect 52, part "validation message with an
output", check `proof4`, path `/html/body[*]/input[*]/alert[*]`, control
`expander-form-hashtag-expansion-declares-the-casedb-02e7ce76-0`. This rests
on reading: the control's bytes are unchanged since the entries held, and the
same pull request retires `vellum_alert`, which can only show more of that
class. Pull request 1's run of that control confirms it. Decided fallback: if
the control shows neither class, the directory is deleted in pull request 1
with that reason in its description, and the first fixed entries are pull
request 3's.

**Spelling rule.** `proof/rules/vellum_alert.py` retires in pull request 1
with its test, its import and its `RULES` line. Since #712
`lib/commcare/xform/builder.ts::buildLeafControl` writes
`<alert ref="jr:itext('<key>-constraintMsg')"/>` wherever the bind carries the
itext message, and a protected message's bind carries a raw expression the
rule's condition never matches, so the rule erases nothing Nova emits. A
control then shows `alert` additions no entry names, which `hold` tolerates on
a control.

**Identity.** none; `proof/identity-moves.json` gains no entry.

**Control.** The 66 named controls keep running under their live entries, the
orphan runs again under finding 52's fixed entries, and from pull request 3
each fix's control keeps running under the fixed entries it gains.

**Nova tests.** All native proof (pytest in the lane):

| Test | Contract |
|---|---|
| `proof/checks/test_registers.py` | A fixed entry whose control stops showing fails; a corpus difference in a fixed class fails as unregistered and is labelled; an id in both registers is refused; a pinned fixed entry matches on its control; removing any one fixed entry's evidence fails. |
| `proof/checks/test_registers.py`, the orphan test | Every directory under `proof/controls/` is named by an entry of one of the two registers, and every `control` either register names is a directory. |
| `proof/lane/test_gate.py` | The gate holds fixed entries on controls, counts them, prints the shared-class note, and imports only the standard library. |
| `proof/store/test_queue.py` | A control only a fixed entry names is queued. |
| `proof/store/test_keys.py` | Editing `fixed-defects.json` changes the judge fingerprint and no observation key. |
| `proof/checks/test_controls.py` | `--as` writes the named directory and leaves the document's own directory untouched, with and without `<into>`; a name a fixed entry's `control` names is refused. |

**Lane.** Locally: `npm run proof -- proof/checks/test_registers.py
proof/lane/test_gate.py proof/checks/test_controls.py proof/store`, then
`npm run proof -- proof/checks -k control-expander-form-hashtag-expansion-declares-the-casedb`
and `python3 -m proof.lane.gate .proof/out`. CI's full lane must show every
control directory's group run or cached (the 67, less `nested-menu-previous`,
plus each of the three pull request 1 retains: work item H's only under its
first outcome), the gate's register section holding
every live entry and finding 52's two fixed ones on their controls, and
`proof/rules` passing with 32 rules.

### Finding 50: the registration alert on a follow-up form

**Today.** Vellum raises "This registration form is missing a case name" on
every save of a follow-up form that opens one child case outside a repeat
(`nested-menu-previous`), and the register holds it as two proof 4 entries
(`d50-registration-alert-vellum-pre-save-alerts-registration-form-missing`
and its `again` twin, control `nested-menu-previous`).

**Fix.** Reclassified as what HQ does itself: nothing Nova can spell removes
it, and it changes no stored app, build or session. HQ counts a form with one
child case outside a repeat a registration form
(`models/forms.py::Form.is_registration_form`) and maps a case name only from
the form's own case (`form_action_diff.py::get_case_mappings`), so its own
editors draw the alert on a form Nova never touched. Proof 4 gains one closed
set, `proof/checks/hq_own_reports.py::HQ_OWN_REPORTS`, whose member for this
finding is `registration_alert_child_case` = (id, editor, path, applies); pull
request 1 adds two more, each read by its own check (Finding 67: grouped tiles
and a reopened incomplete form; Connect's own reading of a renamed block):
`proof/checks/proof4.py::vellum_report` drops a pre-save alert only when a
member names its path and `applies(stored form)` holds, and for this member
`applies` is exactly: `open_case` is not active and exactly one subcase has no
`repeat_context`. `vellum_report` gains no condition of its own; it asks the
set. This block owns the allowance, its condition, its tests and its files;
part 06, 14. Finding 50: reclassified as what HQ does itself, gives only the
reason it is HQ's own and the fact the condition must be no wider than.
`harness-findings.md` moves finding 50 under "What HQ does itself", and the
step's exit allows it by name.

**Files.** Lane: `proof/checks/hq_own_reports.py` (new),
`proof/checks/test_hq_own_reports.py` (new),
`proof/editors/test_hq_own_registration_alert.py` (new),
`proof/checks/proof4.py` (`vellum_report` asks the set),
`proof/known-defects.json` (the two entries leave),
`proof/controls/nested-menu-previous/` (deleted), `proof/timings.json` (its
`control:nested-menu-previous` group leaves). Docs:
`docs/research/2026-09-26-hq-round-trip/harness-findings.md`,
`proof/README.md` ("Proofs 1 to 5", item 4; "Spelling rules and the
registers"), `proof/CLAUDE.md` (the register rule names `HQ_OWN_REPORTS` as
closed and proven).

**Stored shape and migration.** none.

**Register.** Both entries are deleted in pull request 1 and do not become
fixed entries: once proof 4 stops reporting the class, the control no longer
shows it.

**Spelling rule.** none.

**Identity.** none; `proof/identity-moves.json` gains no entry.

**Control.** none afterwards. No other entry names `nested-menu-previous`, so
the directory is deleted with the entries (rule 5 would otherwise fail).

**Nova tests.** Native proof. `proof/checks/test_hq_own_reports.py`: the set
holds exactly its listed members, each with a proof test of its name, and an
unlisted member fails; the member removes exactly that alert on a stored form
where `applies` holds; a registration form that truly lacks a name and a form
with two child cases are still reported; any other `pre_save_alerts` message
is still reported. `proof/editors/test_hq_own_registration_alert.py`: HQ's
own editors, with no Nova export, draw the alert on a blank follow-up form
given one child case by HQ's Case Management save, and do not with a second
child case or with the one child inside a repeat.

**Lane.** Locally `npm run proof -- proof/checks/test_hq_own_reports.py
proof/editors/test_hq_own_registration_alert.py` and
`npm run proof -- proof/checks -k nested-menu-previous`. CI must show proof 4
passing on the corpus document `nested-menu-previous` with no entry.

### Work item H: the unknown-question warning for a case operation's property

**Today.** No corpus document reads `#case/<property>` for a property only a
case operation writes, so defect 3's last clause shows nowhere
(`proof/README.md`, "What the lane does not observe").

**Fix.** Observe it. Pull request 1 adds
`proof/targeted/documents/caseOperationRead.ts`, id
`targeted-case-operation-read`, `rows: ["3"]`: one case-first menu on one case
type, a registration form, a follow-up form whose case operation writes a
property from a select, and a second follow-up form whose text question's
validation reads that property. No field writes the property. The read sits
in a validation because the attribute is a step of proof 4's path
(`.../questions/*/constraintAttr/logic-bad-path-warning/#case~1*`), which
keeps the class apart from finding 47's `calculateAttr` and `relevantAttr`
classes with no judge change.

Two outcomes, both decided:

| Pull request 1's run of the document shows | Then |
|---|---|
| The warning as a class of its own | Two defect 3 entries, part "unknown-question warning for a case operation's property", check `proof4`, artifacts `editor:vellum@*` and `editor:vellum again@*`, ids `d3-operation-read-vellum-logic-bad-path-warning` and `d3-operation-read-vellum-again-logic-bad-path-warning`, document and control `targeted-case-operation-read` (retained for proof 4). The fix that removes them is findings 45 and 47's in pull request 6 (no `#case/` hashtag in any export), which moves both to the fixed register. |
| No class apart from finding 47's (the register refuses a redundant entry) | The document stays in the corpus as a passing document, no entry and no control are added, and the clause is closed by this recorded decision: after pull request 6 no export holds a `#case/` hashtag, and Vellum's only unknown-reference check reads `/data/` paths and hashtags (Vellum `src/logic.js::_addReferences`), so the clause cannot occur. The emission test "no `#case/` hashtag and no `vellum:hashtags` element in any form" holds it. |

**Files.** Lane, pull request 1:
`proof/targeted/documents/caseOperationRead.ts`,
`proof/targeted/index.ts::TARGETED_DOCUMENTS`, and under the first outcome
`proof/controls/targeted-case-operation-read/`, `proof/known-defects.json`
(the two entries) and `proof/timings.json` (the control's group).
`proof/targeted/expected.ts` gives the types and does not change. Lane, pull
request 6: `proof/known-defects.json` and
`proof/fixed-defects.json` (the two entries move, first outcome). Docs, pull
request 1: `proof/README.md` ("The defect rows", row 3; "Targeted
documents"). Docs, pull request 8: `proof/README.md` "What the lane does not
observe" loses the clause and the closing paragraph, with the outcome
recorded; `docs/plans/hq-round-trip/README.md` (step 1 is done).

**Stored shape and migration.** none.

**Register.** Adds two live entries in pull request 1 (first outcome); pull
request 6 moves them to the fixed register, on control
`targeted-case-operation-read`, check `proof4`. Pull request 8 moves none of
them: it only records the clause closed. None remains live at the exit.

**Spelling rule.** none.

**Identity.** none; `proof/identity-moves.json` gains no entry.

**Control.** `targeted-case-operation-read` (first outcome).

**Nova tests.** `proof/targeted/__tests__/targeted.test.ts` (pure: the
document is admitted). In pull request 6, the emission test above (pure,
production emitter).

**Lane.** Locally `npm run proof -- proof/checks -k targeted-case-operation-read`.
CI must show the document's checks held; after pull request 6 the document
passes proof 4 with no entry; pull request 8 only records the clause closed.

### Finding 56: an ordering comparison on a datetime never orders by instant

**Today.** On a device, a datetime held as text (a case property, a literal,
a lookup column, a worker property, a search input) is not a number to
commcare-core `FunctionUtils.toNumeric`, so an ordering comparison over it is
always false; a typed date orders by calendar day only. Executed against Core
during planning. Nova admits such comparisons and Preview orders them by
instant. Defect 6 covers times of day, not this.

**Fix.** Step 2 observes it and does not fix it. Pull request 1 adds the
document `targeted-datetime-ordering`
(`proof/targeted/documents/datetimeOrdering.ts`, `rows: ["56"]`), exactly as
part 08, Finding 56: ordering a date and time never orders by instant on a
device, defines it. That block is the document's definition and this one
defers to it: a survey form whose hidden value compares two datetime answers
one hour apart on one day, and a case list filtered by one datetime property
before another, each with its intent expectation.

What this section relies on from that definition: the document holds no
string literal and no time, so it stays admitted through defect 6's fix
(`XPATH_TIME_ORDERING` refuses a date and time written as a literal, which
holds a colon), its expectations do not depend on the clock, and it shares no
class with defect 6's fixed entries. The two forms witness the two halves:
the typed answers order by calendar day only, and the stored text never
orders. The fix is step 3's, whose typed expression model owns per-operand
lowering; `docs/plans/hq-round-trip/3-expressions.md` carries it. Part 08's
block holds the executed table of operand classes.

**Files.** Lane: `proof/targeted/documents/datetimeOrdering.ts`, which holds
its two expectations in its own file as part 08 states
(`proof/targeted/expected.ts` gives the types and does not change),
`proof/targeted/index.ts`, `proof/controls/targeted-datetime-ordering/`,
`proof/known-defects.json`, `proof/timings.json`. Docs: `harness-findings.md`
(finding 56, with what goes wrong, its source evidence and where its harm
shows), `proof/README.md` ("The defect rows").

**Stored shape and migration.** none.

**Register.** Adds two live intent entries under defect 56, part "datetime
ordering": `d56-datetime-ordering-evaluate` (`evaluate:start-before-end-*`,
`/values/*/value`, values pinned `start before end` to
`start not before end`) and `d56-datetime-ordering-evaluate-rows-caseid` (the
list's `/caseList/rows/*/caseId`, the case pinned to absent). Decided
fallback: where pull request 1's run shows another path or count, the entries
are written from what it shows and the document keeps both forms. No manifest
entry and no surface change. Both remain live at the exit.

**Spelling rule.** none.

**Identity.** none; `proof/identity-moves.json` gains no entry.

**Control.** `targeted-datetime-ordering`, retained in pull request 1 for
intent.

**Nova tests.** `proof/targeted/__tests__/targeted.test.ts` (pure).

**Lane.** Locally `npm run proof -- proof/checks -k targeted-datetime-ordering`
and `-k control-targeted-datetime-ordering`. CI must show its entries held on
the document and the control at every pull request of the stack, and still at
the exit.

### Finding 57: a case list column over `case_id` is blank on HQ's build

**Today.** HQ's `detail_screen.py::CASE_PROPERTY_MAP` has no `case_id` entry
and the case database holds the id only as an attribute, so a property column
over `case_id` builds blank; a hidden sort carrier over `case_id`, `owner_id`
or `status` also makes HQ's Case List page refuse to save. Executed during
planning. No control holds such a column, so the lane has never seen it.

**Fix.** The fix is pull request 11's (an attribute-backed property column
writes the expression arm, and a hidden carrier writes `invisible` with a
positional sort), in part 07, Finding 57: the `case_id` column and
attribute-backed hidden carriers. The document, its expected entries and its
control are as that block names them, under "Its targeted documents" and in
its register table; this section owns only that pull request 1 adds them,
before the fix. The document is `targeted-case-id-column`
(`proof/targeted/documents/caseIdColumn.ts`, `rows: ["57"]`): a shown column
over `case_id` and a hidden column over `owner_id` that carries the list's
only order rule. The second document of that file,
`targeted-attribute-columns`, is pull request 11's and is no part of the
observation: part 07 defines it there, with its two lists, the second of
which holds the shown link over `status` whose order rule is the one
bare-name sort row left, so the lane keeps a document for that spelling.

**Files.** Lane, pull request 1: `proof/targeted/documents/caseIdColumn.ts`,
which holds its own expectations (`proof/targeted/expected.ts` gives the
types and does not change), `proof/targeted/index.ts`,
`proof/controls/targeted-case-id-column/`, `proof/known-defects.json`,
`proof/timings.json`. Docs: `harness-findings.md` (finding 57),
`proof/README.md` ("The defect rows").

**Stored shape and migration.** none in this section.

**Register.** Pull request 1 adds the live entries under defect 57 that part
07's register table names, written from its own lane evidence: three are
expected, `d57-case-id-column-evaluate-values-value` (intent),
`d57-case-id-column-trace-rows-fields` (proof 3) and
`d57-case-id-column-editor-save-unsent` (proof 4, `/save/unsent/*`). Row
order is no class: today's hidden carrier already reads `@owner_id` on HQ's
build, so both paths order alike. Decided fallback: an expected class the run
does not show gets no entry, and a class the run shows beside the three is
registered under the same `d57-case-id-column-` prefix. Pull request 11
moves every one to the fixed register. None remains live at the exit.

**Spelling rule.** none.

**Identity.** none; `proof/identity-moves.json` gains no entry.

**Control.** `targeted-case-id-column`, retained in pull request 1 for the
checks those entries name.

**Nova tests.** `proof/targeted/__tests__/targeted.test.ts` (pure).

**Lane.** Locally `npm run proof -- proof/checks -k targeted-case-id-column`.
CI must show the entries held in pull requests 1 to 10, and from pull request
11 the document passing with its `expected.json` values and no entry.

### Finding 63: HQ's build installs on Android only with its media (what HQ does itself)

**Today.** The lane hands Core HQ's build as HQ's index download arranges it (`hqmedia/views.py::iter_index_files`: the suite, the profile, the app strings and the forms), and Core admits that. Android's install of the same archive fails with `AppInstallStatus.UnknownFailure`: its media installer goes to the network for each file the media suite names. HQ's download with multimedia (`iter_app_files`) installs, and so does Nova's local `.ccz`, which carries its media. Observed by the Android reader (`proof/android`, commcare-android's own installers under Robolectric) over every document whose build names media.

*Harm:* none to a worker, who installs from HQ or from a file that holds the media. It bounded the lane: Core's admission of an index-only archive does not stand for a device's install.

**Fix.** Recorded as what HQ does itself: it is HQ's own download arrangement and Android's own installer, and Nova's export takes no part in it. On the lane's branch each built state's record keeps the archive a device installs, HQ's own download with multimedia (`state.archive`, `proof/observe/build.py::device_archive`), and the Android stage installs that archive; `proof/checks/test_device_archive.py` holds the record to HQ's own download. Pull request 1 moves finding 63 under "What HQ does itself" in `docs/research/2026-09-26-hq-round-trip/harness-findings.md`, with its citations, and the step does nothing else for it.

**Files.** `docs/research/2026-09-26-hq-round-trip/harness-findings.md`. The lane's are landed on its branch: `proof/observe/build.py`, `proof/checks/test_device_archive.py`, `proof/README.md`.

**Stored shape and migration.** None.

**Register.** None. No entry ever named it: the lane hands Android the archive a device installs, so no check reports the index-only failure, and no allowance is needed.

**Spelling rule.** None. **Identity.** None; `proof/identity-moves.json` gains no entry. **Control.** None.

**Nova tests.** None: nothing of Nova's changes.

**Lane.** `npm run proof -- proof/checks/test_device_archive.py`. CI's full lane: the Android stage installs every built state's device archive.

### Finding 67: grouped tiles and a reopened incomplete form

**Today.** A form left incomplete under grouped tiles, for a case with no connection of the grouping's name, cannot be reopened on Android: the session descriptor's last datum, `case_id_parent_ids`, has an empty value, Android splits the stored line on spaces, and home raises `ArrayIndexOutOfBoundsException` (part 07, Finding 67: an incomplete form under grouped tiles, for a case with no connection, gives the readers and the citations). The Android stage shows it on HQ's build and Nova's local archive alike, and the register holds it as two proof 1 entries on `tile-grouped-one` (`d67-android-proof1-b-update-reopened-session-changed`, `d67-android-proof1-local-ccz-update-reopened-session-changed`, path `/update/reopened/*/session`).

**Fix.** Reclassified as what CommCare does itself: the datum is HQ's (`suite_xml/sections/entries.py::EntriesHelper.get_extra_case_id_datums`) and the reader is commcare-android's (`SessionDescriptorUtil.loadSessionFromDescriptor`), so an app HQ's own editors make with grouped tiles fails the same way, and nothing Nova can spell removes it while keeping the datum HQ's build reads. `HQ_OWN_REPORTS` gains the member `android_grouped_tile_reopen` = (id, artifact `android@*`, path `/update/reopened/*/session`, applies), read by proof 1's Android comparison (`proof/checks/android.py`), which drops the difference only when a member names its path and `applies(record)` holds. For this member `applies` is exactly: the reopened form's stored session descriptor ends at a datum whose id is `case_id_parent_ids` with no value after it, and home's answer is the `ArrayIndexOutOfBoundsException` above. The check gains no condition of its own; it asks the set. Part 07's block owns the builder, tool and docs copy and the upstream report; this block owns the allowance, its condition, its proof and its files.

**Files.** Lane: `proof/checks/hq_own_reports.py` (the member), `proof/checks/test_hq_own_reports.py` (its case), `proof/checks/android.py` (proof 1's Android comparison asks the set), `proof/android/test_hq_own_grouped_tile_reopen.py` (new), `proof/known-defects.json` (the two entries leave), `proof/controls/tile-grouped-one/` (deleted: no other entry names it), `proof/timings.json` (its group leaves). Docs: `docs/research/2026-09-26-hq-round-trip/harness-findings.md` (finding 67 under "What HQ does itself", with the upstream issue's link), `proof/README.md` ("Proofs 1 to 5" and "The Android stage" name the member).

**Stored shape and migration.** None.

**Register.** Both entries are deleted in pull request 1 and do not become fixed entries: once the check stops reporting the class, the control no longer shows it.

**Spelling rule.** None. **Identity.** None; `proof/identity-moves.json` gains no entry.

**Control.** None afterwards; `proof/controls/tile-grouped-one` is deleted with the entries, and the corpus document stays.

**Nova tests.** Native proof. `proof/checks/test_hq_own_reports.py`: the member drops exactly that difference on a record where `applies` holds, and a reopen difference whose descriptor ends otherwise, or whose answer is another error, is still reported. `proof/android/test_hq_own_grouped_tile_reopen.py`: an app made in HQ's own pages with no Nova export (a case menu, HQ's Case List page under the tile flags given grouped tiles over the `parent` connection, one follow-up form saved in HQ's form builder), built by HQ and installed by the Android reader as a device installs it; a form left incomplete for a case with no parent and reopened after an update raises at home, and the same for a case with a parent reopens. This test is the upstream witness too: at a commcare-android pin whose reader handles the empty value it fails, and the member then leaves the set in that pin's pull request.

**Lane.** Locally `npm run proof -- proof/checks/test_hq_own_reports.py` and the Android test on the Android runtime (`python3 -m unittest proof.android.test_hq_own_grouped_tile_reopen`). CI must show proof 1 passing on `tile-grouped-one`, `tile-grouped-two` and `tile-grouped-search` with no entry, and the member's test passing in the Android stage.

### Connect's own reading of a renamed block

**Today.** On the two documents whose edit renames their Connect ids, with the opportunity made from A's release, the Connect judge reports what Connect then does (part 08, Defect 15's Connect forwarding: deliveries refused between a rename and a new payment unit, gives the readers): every delivery of the renamed deliver unit refused 400, a second learn module, the renamed ids moved. The register holds five proof 4 entries, artifact `connect@B-edit@*`, under defect 15: `d15-connect-ids-renamed-connect-b-edit-ids-deliver-moved`, `-ids-task-moved`, `-refused-400-payment-unit` (on `targeted-connect-deliver-rename`), `-ids-module-moved` and `-catalog-learnmodules-added` (on `targeted-connect-learn-rename`).

**Fix.** Reclassified as what Connect does itself: Connect keys an opportunity's rows by each block's id (commcare-connect `form_receiver/processor.py::get_or_create_learn_module`, `get_or_create_deliver_unit`, `process_task_modules`), so any app whose block id changes under an opportunity holding the old one meets the same refusals, whoever changed it, and no spelling of a renamed block avoids it. What Nova owns is the order of the rename and the manager's payment unit, which part 08's block says on every surface. `HQ_OWN_REPORTS` gains the member `connect_block_renamed` = (id, artifact `connect@B-edit@*`, paths `/ids/deliver/moved`, `/ids/task/moved`, `/ids/module/moved`, `/runs/*/refused/400/payment-unit-is-not-configured-for-the-deliver-unit` and `/runs/*/catalog/learnModules/added`, applies), read by the Connect judge's `beyond` report (`proof/checks/connect.py`). For this member `applies(A, B-edit)` is exactly: a Connect block that A's stored form holds is absent from B-edit's stored form, and B-edit's form holds a block of the same kind at the same path under another id; each report is dropped only for a block that meets it. A refusal of any other cause, an id that moved with no block renamed in the edit, or a block added beside the old ones, is still reported.

**Files.** Lane: `proof/checks/hq_own_reports.py` (the member), `proof/checks/test_hq_own_reports.py` (its case), `proof/checks/connect.py` (`beyond` asks the set), `proof/connect/test_hq_own_rename.py` (new), `proof/known-defects.json` (the five entries leave), `proof/controls/targeted-connect-learn-rename/` (deleted: no other entry names it), `proof/timings.json`. Docs: `docs/research/2026-09-26-hq-round-trip/harness-findings.md` (the rename consequences, now under "What HQ does itself", beside HQ giving up on a forward Connect refused), `proof/README.md` ("Connect in the unit").

**Stored shape and migration.** None.

**Register.** The five entries are deleted in pull request 1, not moved, for the reason finding 50's are.

**Spelling rule.** None. **Identity.** None; `proof/identity-moves.json` gains no entry.

**Control.** `targeted-connect-learn-rename`'s directory is deleted with its two entries; `targeted-connect-deliver-rename`'s stays, named by the entries of findings 34, 59 and 61.

**Nova tests.** Native proof. `proof/checks/test_hq_own_reports.py`: the member drops each of the five reports on a pair where `applies` holds, and keeps each where the edit renames nothing, where a block is added beside the old one, and for a 400 with another message. `proof/connect/test_hq_own_rename.py`: a deliver app and a learn app made in HQ's own pages with no Nova export (each form built in HQ's form builder with its Connect questions under `COMMCARE_CONNECT`), released, an opportunity made from the release, then each block's id changed in HQ's form builder and the app released again, and devices' submissions taken by HQ's receiver and forwarded by its Connect repeater: Connect refuses the renamed deliver unit's delivery with the same 400, makes a second learn module, and completes no assigned task with the renamed task, and HQ marks the refused forward `PayloadRejected` and does not send it again.

**Lane.** Locally `npm run proof -- proof/checks/test_hq_own_reports.py proof/connect/test_hq_own_rename.py`. CI must show proof 4 passing on both rename documents with no defect 15 entry, and the member's test passing.

## Why `proof/identity-moves.json` stays empty

`proof/identity-moves.json` gains no entry in step 2, and the outline's "adds
the identity moves it decides" is withdrawn.

- Proof 1 compares A with B, A with B-edit outside the edit's footprint, and
  `local.ccz` with `local-again.ccz` (`proof/checks/proof1.py::document_identity`).
  All three compare two exports of the current document by the current code.
  A stored-document migration, an emitter rename, a moved case block or a
  renamed language code changes both sides alike and shows in none of them.
  On a control both sides are pre-fix bytes.
- A move accepts its path on every document
  (`proof/checks/registers.py::accepted_moves`), so a move for, say,
  `/lookup_tables/*/id` would hide the very regression a fix removes.
- A lane judgment across the step (a control's A against the same document's
  A today) was considered and rejected: it needs a second `a` record per
  control on every cold run, it could say nothing about ids (which the ledger
  preserves, proven in Nova against real Postgres), and the lane holds no
  deployment made before the step.

The step's one-time identity changes are real, and they exist only in
deployments and installs made before step 2. They are held in three places:
each fix's "Identity" part in this plan; the cutover's notice, which names
every app, entity and deployment a change touches; and the cutover's pure
tests over the frozen pre-step fixtures
(`scripts/lib/hqRoundTripCutover/__tests__/fixtures/pre-step/`), which assert
each moved wire identity by parsing the pre-step emission and the post-step
one, never by pattern. Those fixtures leave with the tooling in pull request
16, after the cutover has run; the notices are the durable record.

What moves once for an existing deployment, at its first publish after the
cutover (or its first `.ccz` after it):

| Identity | Moves for | From, to | Fix |
|---|---|---|---|
| Form `unique_id` | a form in a project space without API access, or whose form ids every credential was refused | HQ's id, to the derived one; `xmlns` is kept | work item A |
| Menu and form `unique_id`, form `xmlns` | a menu or form the cutover left without a pair, and every entity of a deployment no credential could read | HQ's values, to the derived ones | work item A |
| The HQ app itself | a deployment whose HQ app HQ reports gone | ended by the cutover; the next publish creates a new app that carries the space's recorded ids | work item A |
| Form `xmlns` and profile `uniqueid` in a `.ccz` | every device holding a `.ccz` built before step 2 | random per build, to the derived `xmlns` and the app's UUID; the phone installs the first fixed archive as a new app once | work item A, defect 9 |
| Data path of every generated node | every form that emits one | `__nova_<purpose>` to `nova_<purpose>`; `nova_operations` and `nova_subcases` become groups; a conditional operation's block moves inside `nova_condition_<operation>`; the guards become `nova_guard_<operation>_<kind>`. `nova_count_<repeat>` and `nova_constraint_message_<question>` do not move. The exact map is `lib/commcare/xform/generatedNodes.ts::planGeneratedNodes`, tabled in part 05, Every node the emitter adds to a form | defect 13 |
| New submitted leaves | forms with guarded or shared case ids, and forms whose basic actions read a name or external id | `nova_caseid_<operation>`, `nova_trimmed_<question>` appear | defect 13, finding 33 |
| Question data path | a question whose id the validator now refuses (leading underscore, leading `XML`, `meta`, `instance`, `bind`, `parsererror`) | the old id, to the migrated id, with every relative path and `case_references_data` key that names it | defect 15, finding 43 |
| Case operation block path | a case operation whose id is renamed | the old id, to the migrated id | defect 15 |
| Session endpoint id | an entry point whose id is not a `slugify` fixed point | the old id, to its slug; a shared link with the old id needs a republish and a new link | defect 15 |
| Connect learn module, deliver unit and task ids | a Connect block whose id is renamed | the old id, to the migrated id; Connect reads each renamed block as new | defect 15 |
| Select option value | the second and later options that share a value | `value`, to `value_2` and up | finding 44 |
| Lookup table tag, and with it the table's id in HQ and the fixture instance id | a table whose tag contains `casedb` or `ledgerdb` | the old tag, to the renamed tag; the next publish creates the new table and leaves the old one in HQ | defect 5 |
| Close block position | a form whose close condition HQ's Case Management tab cannot state | the form's basic close action, to a Save to Case block `nova_close` inside its condition group | defect 14 |
| New case ids | a root create keyed by a form answer | the answer's value, to a generated id read from the session datum `case_id_new_<type>_0`, for cases created after the cutover | defect 13 |
| A menu's case type in HQ | a survey-only menu | `''`, to the document's case type | defect 14 |
| Search input name | an input named like a default filter | the old name, to the suffixed name | defect 14 |

Nothing moves for a language's wire code (`localization.wireCodes` stores the
code each language already has), for a link identifier (a leading underscore
stops the cutover for a person), or for `case_preload` (untouched in step 2).

## The spelling rules

Nine rules retire and 24 stay. "Retires" means the named fix makes Nova write
the editor's spelling; the pull request deletes the module, its test, its
import and its `RULES` line, and the lane passing without the rule is the
proof. If the lane refuses a retirement (a difference the rule erased still
shows on a corpus document), the rule stays and the pull request says why:
that is a legitimate outcome for a retirement and never for an entry.

Only the two `trace` rules compare the two export paths; every other rule
judges HQ's stored app, HQ's builds and HQ's forms against each other (proofs
2 and 4).

| # | Rule (`RULES` order) | Verdict | The fix and pull request, or the reason it stays |
|---|---|---|---|
| 1 | `vellum_attributes` | stays | Vellum's save adds `vellum:*` attributes Nova does not write. |
| 2 | `vellum_hashtags` | stays | Vellum's save rewrites the head maps. Its test moves with findings 45 and 47's fix (pull request 6), which changes what it finds on `expander-form-hashtag-expansion-emits-the-editor-1daa5537-0`. |
| 3 | `required_condition` | stays | Vellum's own attribute. |
| 4 | `vellum_alert` | retires, pull request 1 | Nova already writes Vellum's spelling (#712); above. |
| 5 | `select_string_type` | stays | No step 2 fix stops typing select binds, and no defect asks for it. |
| 6 | `empty_binds` | stays | Vellum writes bare binds for groups, repeats and, from pull request 7, `nova_operations`; finding 55's `work_area_id` bind is one. |
| 7 | `itext_value_order` | stays | Vellum's order. |
| 8 | `model_order` | stays | Vellum's order. |
| 9 | `setvalue_order` | stays | Vellum's and HQ's order. |
| 10 | `case_references_load` | stays | Defect 3's fix writes `save` only. Vellum recomputes `load` on every save (Vellum `src/logic.js::caseReferences`), and no fix makes Nova write Vellum's exact map. |
| 11 | `add_ons` | stays | `views/apps.py::edit_add_ons` writes every slug `add_ons.py::get_dict` returns. Defect 4's fix writes each needed slug `true` and never `false`, so the page's save still adds a `false` for every other slug and for one the project's privileges withhold. Retiring it would need Nova to write every slug at values that depend on the target. |
| 12 | `profile_features_users` | stays | Finding 40's fix writes `profile.properties` only; the settings save still writes `features.users` (`views/settings.py::edit_commcare_profile`). |
| 13 | `profile_custom_properties` | stays | Written only under `CUSTOM_PROPERTIES`. |
| 14 | `empty_media_maps` | stays | A language-keyed page value no fix names. |
| 15 | `case_list_form_unset` | stays | Same. |
| 16 | `detail_null_booleans` | stays | No fix changes `lib/commcare/hqShells.ts::detailBase`'s nulls. |
| 17 | `column_tab_keys` | stays | The page computes `nodesetCaseType` from its own schema. |
| 18 | `tile_cell_fields` | stays | Defect 14's tile fix writes cells on custom tiles only, and the rule's condition is "not a custom tile". |
| 19 | `lookup_fields_unshown` | stays | Written only under `CASE_LIST_LOOKUP`. |
| 20 | `inactive_parent_select` | stays | The page computes the module id. |
| 21 | `preload_condition` | stays | `case_preload` is not touched in step 2: its editable spelling is defect 28's (step 5). |
| 22 | `condition_operator_default` | stays | No fix names it. |
| 23 | `form_link_fallback` | stays | No fix changes how no fallback is spelled; a fallback beside form links is defect 26's (step 5). |
| 24 | `update_never_beside_actions` | retires, pull request 9 | Defect 14's non-writing follow-up: `update_case` is `always` on every registration, follow-up and close form, which are the rule's three "build alike" cases. |
| 25 | `subcase_empty_strings` | stays | No fix names it. |
| 26 | `sort_display_empty` | retires, pull request 11 | The case-list order plan writes `{<langs[0]>: ""}`, which is what `views/modules.py::_update_sort_elements` writes in the editing language. It needs pull request 3's wire codes first, since `langs[0]` is a wire code. |
| 27 | `sort_type_plain` | retires, pull request 11 | Nova writes the sort `type` HQ's page keeps. |
| 28 | `search_title_empty` | retires, pull request 11 | With finding 54: `views/modules.py::_gather_and_update_search_properties` writes `title_label` and `description` in adjacent statements, and Nova writes both the same way. |
| 29 | `sort_blanks_default` | retires, pull request 11 | Nova writes `first` or `last` in HQ JSON. The rule's `suite.xml` globs never match the local archive's suite, so nothing in the `.ccz` bears on it. |
| 30 | `sort_calculation_pair` | retires, pull request 11 | `sort_calculation` is `""` everywhere; this changes what a label column sorts by, which is defect 10's fix. |
| 31 | `profile_unread_properties` | stays, widened in pull request 5 | After finding 40's fix the stored app holds `profile.properties`, and a no-change settings save adds the keys Nova does not write: the five the rule names and `log_prop_weekly`. The rule's artifact glob gains `app.json` with those six keys at `/profile/properties/<key>`, and its test proves HQ's build does not depend on them. Without the widening the save leaves a class no entry holds. |
| 32 | `profile_required_minimal` | retires, pull request 5 | Defect 9: the `.ccz` profile writes `requiredMinimal="0"`. |
| 33 | `case_block_position` | retires, pull request 9 | Finding 37 gives a repeat subcase's own block the position HQ's build gives it. |

`proof/rules/conftest.py::DOCUMENTS` loses six ids as the nine retire, each in
the pull request that retires its last reader:
`expander-form-hashtag-expansion-emits-validate-msg-as-an-fe6783cb-0` (pull
request 1), `case-capture-multiple` and `nested-menu-same-multiple` (pull
request 9), `expander-expanddoc-hq-json-projection-sort-elements-1e1c54c0-0`,
`-5899296f-0` and `search-browse` (pull request 11).
`proof/rules/test_closed_set.py` fails on a module left unlisted, so a retired
rule's module and test are deleted together.

## The entry accounting

### The 454 entries step 2 empties

Every entry leaves `proof/known-defects.json` in the pull request named. 451
move to `proof/fixed-defects.json` with id, class and control unchanged, and
three are deleted (the exceptions below the table). Controls are the ones
each entry already names.

| Defect or finding | Parts | Entries | Checks | Fix group | Pull request |
|---|---|---|---|---|---|
| 1 | ids and `xmlns` 4, local path 1, language codes 2 | 7 | proof 1 6, bar 1 | A, identity | 3 |
| 2 | display condition on the loaded case | 1 | bar | D, app-level | 5 |
| 3 | case references save, case-property inventory, data dictionary | 3 | proof 4 1, intent 2 | D, defect 3 | 8 |
| 4 | `auto_gps_capture` 4, translations 1 | 5 | proof 2 4, proof 3 1 | D, app-level | 5 |
| 5 | table content 7, reserved substrings 2 | 9 | proof 1 7, intent 1, manifest 1 | E, lookup | 14 |
| 6 | CSQL 6, Core 5 | 11 | manifest 8, intent 3 | E, CSQL | 14 |
| 7 | saved and incomplete forms | 2 | proof 3 | D, app-level | 5 |
| 8 | barcode and secret validation | 2 | intent | D, app-level | 5 |
| 9 | required version 2, `uniqueid` 1, form version 1 | 4 (3 moved, 1 deleted) | proof 3 3, proof 1 1 | D, app-level | 5 |
| 10 | label-column and unsorted order | 2 | proof 3 | case lists | 11 |
| 12 | custom tile 6, single-date prompt 2, related lookups 1 | 9 | proof 4 8, intent 1 | C, gates | 13 |
| 13 | datetime leaves 5, root create id 14, `#form/` defaults and block ids 4, blank translations 5, shadows 8, and the 13 leaf-constraint entries of "wrapper conditions and leaf guards" | 49 | proof 4 45, manifest 4 | XForm, first part | 6 |
| 13 | guard blocks 67, reserved names 25, wrapper containers 6, and the other 29 of "wrapper conditions and leaf guards" | 127 | proof 4 105, manifest 22 | XForm, second part | 7 |
| 14 | data node name | 3 | proof 4 | XForm, first part (with finding 46) | 6 |
| 14 | non-writing follow-up 11, close conditions 23 | 34 | proof 4 18, manifest 10, proof 3 5, bar 1 | case writes | 9 |
| 14 | tiles | 9 | proof 4 7, manifest 2 | case lists | 11 |
| 14 | multi-select destinations 3, search settings 11, an input named like a default filter 3, survey menus 1 | 18 | proof 4 8, manifest 8, bar 1, intent 1 | menus and search | 12 |
| 14 | logos | 2 | bar 1, manifest 1 | C, gates | 13 |
| 15 | question ids 7, entry-point ids 3, question and entry-point ids 2 | 12 | proof 4 8, manifest 3, bar 1 | identifiers | 10 |
| 16 | hidden columns | 1 | intent | case lists | 11 |
| 31 | a form of empty groups | 1 | bar | identifiers | 10 |
| 32 | searches from a local `.ccz` | 3 | proof 3 | A, downloads | 3 |
| 33 | trimmed case names and external ids | 16 | proof 3 | case writes | 9 |
| 34 | Connect location capture | 1 | proof 3 | D, app-level | 5 |
| 35, 36 | hidden select column text, hidden sort column offered | 2 | proof 3 | case lists | 11 |
| 37 | new case order | 2 | proof 3 | case writes | 9 |
| 38 | image-map column width | 2 | proof 3 | case lists | 11 |
| 39 | local profile locale | 1 | proof 3 | D, app-level | 5 |
| 40 | app settings save writes HQ's defaults | 76 | proof 4 | D, app-level | 5 |
| 41 | empty-list text goes blank | 2 | proof 4 | case lists | 11 |
| 42 | custom-tile cell alignment | 5 | proof 4 4, manifest 1 | case lists | 11 |
| 43 | a question named `instance` 3, `bind` 2 | 5 | proof 4 4, manifest 1 | identifiers | 10 |
| 44 | duplicate option values | 4 | proof 4 2, manifest 2 | identifiers | 10 |
| 45 | blanked case id, owner and status reads | 3 | proof 4 | XForm, first part | 6 |
| 46 | form renamed in HQ's editing language | 3 | proof 4 | XForm, first part | 6 |
| 47 | unknown-question warnings | 4 | proof 4 | XForm, first part | 6 |
| 48 | mixed-quote search answer | 2 | manifest | E, CSQL | 14 |
| 50 | registration alert on a follow-up | 2 (deleted) | proof 4 | lane mechanics | 1 |
| 51 | sort keys | 2 | proof 3 | case lists | 11 |
| 53 | zero-input search sentinel | 2 | proof 3 | menus and search | 12 |
| 54 | empty search description | 3 | proof 4 | case lists | 11 |
| 55 | Connect work area id | 3 | proof 4 | XForm, first part | 6 |
| | | **454** | proof 4 309, manifest 65, proof 3 44, proof 1 14, intent 11, bar 7, proof 2 4 | | |

By pull request, entries leaving the live register: 1 deletes 2; 3 moves 10;
5 moves 91 and deletes 1 (`d9-form-version-trace-version`); 6 moves 65;
7 moves 127; 8 moves 3; 9 moves 52; 10 moves 22; 11 moves 28; 12 moves 20;
13 moves 11; 14 moves 22. 451 moved, 3 deleted. Pull requests 2, 4, 15 and 16
move none. Finding 40's 76 are among pull request 5's 91 with no variant: the
settings page keeps every value Nova writes (executed during planning; part
04, Finding 40: an HQ settings save writes its defaults into the profile), so
no key is held open and no count depends on that run.
These counts are of the 454 entries the register holds today; entries the
step itself adds and later moves ("The entries step 2 adds") are counted
there, so pull request 6 moves two more where work item H registered its
class, pull request 11 moves finding 57's, and pull request 13 moves three
more where pull request 11 registered defect 12's explicit tile cell classes.

The 13 leaf-constraint entries pull request 6 moves are twelve proof 4 text
differences (`d13-wrapper-conditions-form-case-name-constraint-*` and
`d13-wrapper-conditions-source-case-name-constraint-*`, paths ending
`/@constraint`) and one manifest class
(`d13-wrapper-conditions-form-bindconstraint-in-a-savetocase-block`, `*form:*`,
`/xform:model~1bind@constraint/refused/in-a-savetocase-block`). They leave
when the seven leaf `constraint` attributes are deleted. Resting on reading:
that no other bind inside a Save to Case block carries a `constraint` after
pull request 6. Decided fallback: if pull request 6's run still reports the
manifest class on a corpus document, that one entry stays live and moves in
pull request 7 (48 and 128 in place of 49 and 127; manifest 3 and 23 in place
of 4 and 22), re-documented by the re-homing rule. The part's other 29 need
the condition groups.

Exceptions, each named in its pull request:

| Entry or class | What happens | Why |
|---|---|---|
| `d9-form-version-trace-version` (proof 3, `trace@local.ccz`, `/runs/*/trace/*/submission/data/@version`) | Deleted in pull request 5, not moved. `proof/checks/proof3.py` reads a submission's version across the two export paths as each path's own counter (as `proof/checks/proof4.py::trace_versions` already maps it between A's and B's builds), and a new intent check, `proof/checks/intent.py::local_archive_versions`, holds each local archive's form, resource and profile version to the document's sequence, which `Intent` carries as `sequence` (from the corpus entry's `compiledAtSeq`); a control whose retained intent holds no `sequence` gets no claim from it. | HQ's form version is HQ's own counter and the local archive's is the document's sequence; they agree only by coincidence, so no emitter can remove the difference. After the judge change the control no longer shows it. The judge's own test is its proof. |
| Finding 50's two | Deleted in pull request 1 with `HQ_OWN_REPORTS`'s member. | Above. |
| Finding 40's 76 | All move in pull request 5, with two changes in the same pull request. `profile_unread_properties` widens (rule 31). `proof/checks/intent.py::profile_settings` stops holding every `setting:properties.*` of HQ's built profile to `_unstated_setting`: it holds each to what the document states (the explicit settings and `appSettings`), and reads a control whose retained intent carries no settings as the pre-fix statement, "HQ's settings for none", so `profile_settings` judges that control as today. | Once Nova states profile properties, the old judge would report `/profile/property[@key=...]/@value` on every corpus document. Executed during planning, in the lane's HQ, under the minimum and the maximum configuration (part 04, Finding 40: an HQ settings save writes its defaults into the profile, holds the seventeen values): the settings page's no-change save keeps every one of Nova's seventeen values, `cc-fuzzy-search-enabled`, `cc-gps-auto-capture-accuracy` and `cc-content-valid` included, and a second save is a fixed point. The first save adds only the six properties the widened rule erases and `features.users`, which `profile_features_users` erases. So there is no fallback: every key is written, all 76 move, and none is held open. Pull request 5's run of `case-operation-query` is the standing check of the same fact. On HQ the fifteen constant settings are seeded only where the target holds no value (part 04, the same block); a corpus target is new and holds none, so the lane's first update carries all seventeen and the judge holds each. |
| Finding 34's entry (`d34-connect-location-trace-meta-location`) | In pull request 5's first commit, before defect 4's proof 3 judge change and before any emitter change, a control `connect-location-capture` is retained from `targeted-invalid-connect-ids` with `--as` (`python3 -m proof.checks.controls <corpus> targeted-invalid-connect-ids proof3 --as connect-location-capture`), and the entry's `control` becomes it. The entry then moves to the fixed register on that control in the same pull request. | Its control today, `targeted-hq-side-state`, shows the class only because a person saved Auto Capture Location there, and defect 4's judge change (`proof/checks/proof3.py` holds a stated HQ-side `auto_gps_capture` both ways; part 04, Defect 4: a republish overwrites values kept in HQ) stops reporting it on that document. `targeted-hq-side-state` is named for finding 34 nowhere from then on. |
| `d4-translations-app-strings-home-start` | Moves in pull request 5 like the rest. | `home.start` is a UI-catalog key Nova leaves at HQ's value from step 2, so the saved value survives the next publish. The control replays the legacy layout, which replaces `translations` whole, and keeps showing it. |
| Defect 12's nine | Move in pull request 13. They leave by a configuration change, not an emission change: each document's minimum configuration gains the flag, and `targeted-custom-tile` loses its `CASE_LIST_TILE` named configuration. Where pull request 11's run registered the three explicit tile cell classes (`d12-custom-tile-app-horizontal-align`, `-vertical-align`, `-font-size`, on the control `targeted-custom-tile-explicit-cells`; part 07, Tile cells and finding 42, and "The entries step 2 adds"), they move here with the nine by the same configuration change, twelve in all (part 03, C3. Defect 12: the flag probe). | The controls keep their pre-fix `configurations.json` and `verdict.json`. Defect 14's tile entries and finding 42's five move in pull request 11, before the configuration leaves, so nothing depends on whether they would still show without it. |
| Defect 5's seven table entries | Move in pull request 14. They leave because Nova's refusal means no B exists, so proof 1 has nothing to compare. | Their document is `targeted-hq-side-lookup` from pull request 1 ("Corpus changes"). |
| The 58 `equivalence` entries (finding 40 fifty, 42 two, 54 three, 55 three) | Move like any other. | Nova writes the other spelling, and the control keeps showing that the two spellings differ. |

Three entries cannot become fixed entries (the form version and finding 50's
two), so pull requests 1 to 14 add 451 fixed entries for these defects.

### The 159 entries that remain

| Defect | Entries | Step 2 fix that touches them | Pull request | What the pull request does |
|---|---|---|---|---|
| 20 (sync on form entry) | 12 | none | | Stand. Nine share `trace@local.ccz` with findings 32, 33 and 53 on other paths. |
| 21 (list-first turned search-first) | 25 | none | | Stand. |
| 23 (attachment-mode capture) | 67 | defect 13's rename and groups | 7 | 60 entries hold a `__nova_` name in `path`, on six documents and their six same-named controls (`case-capture-multiple`, `case-extension-multiple`, `case-extension-multiple-repeat`, `case-extension-query`, `case-extension-registration`, `case-extension-repeat`). Those directories also serve defect 13, 14, 33 and 37 entries that become fixed entries and need the old bytes, so they are not retained again. Pull request 7 retains six new controls from its own corpus, named `<old control name>-after-13` (`python3 -m proof.checks.controls <corpus> <document id> manifest,proof3,proof4 --as <old control name>-after-13`, the document being the one of the same name; the stack table's row 7 uses the same name), rewrites the 60 paths from that run's evidence, and points the 61 entries that name one of the six old directories (the 60 and `d23-attachment-form-instance-attachment-in-a-savetocase-block`, control `case-extension-registration`) at its `-after-13` twin. The other six name `case-capture-followup`, hold no Nova name, and keep their paths and their control. |
| 24 (inert subcase) | 12 | defect 13's subcase groups, then findings 33 and 37, which move the local archive's blocks | 7, 9 | Pull request 7 points all twelve at the new `case-extension-registration-after-13`, `-query-after-13` and `-repeat-after-13`. Pull request 9 reads the five `trace@local.ccz` paths from its run; where one moved it re-paths the entry and retains the `-after-13` control again in place, which rule 6 allows because no fixed entry names an `-after-13` directory. |
| 25 (query repeats) | 24 | defect 13's ref-less repeat group and shadows | 6 | `d25-query-repeat-vellum-parse-warning-bind-node-found` and `d25-query-repeat-source-bind-nodeset` (document `container-query-conditional-relative`, control `container-query-conditional`) rest on the repeat's wrapper group. The re-homing rule below applies to them; the other 22 name no Nova node and stand. |
| 26 (hidden links and navigation fallbacks) | 9 | none | | Stand. A fallback beside form links is exempt from `POST_SUBMIT_NOT_OFFERED` until step 5, so `targeted-form-links-hidden-and-fallback` stays admissible and its bytes outside defect 13's nodes do not change. |
| 27 (user repeat in a labelled group) | 3 | the ref-less repeat group | 6 | Expected to stand: Vellum already takes such a group's path from its repeat (Vellum `src/parser.js`, the `group` control adaptor), so the fix changes no parse. The re-homing rule applies if pull request 6's run of `targeted-labelled-group-repeat` shows otherwise. |
| 28 (load-time values) | 3 | none on the class | 6 | Stand: Nova keeps emitting `case_preload`. The document also shows defect 13's default error today; that leaves in pull request 6, after which the control serves two fixed entries and three live ones on unchanged paths. |
| 30 (repeat count copy) | 4 | the one allocator for generated names | 7 | Stand: `nova_count_<repeat>` is not renamed, and `names.py` keeps writing it `*`. |

**The re-homing rule**, for a remaining entry whose document or path a step 2
fix disturbs before the entry's own fix. The pull request that disturbs it
does the first of these that applies, and says which in its description:

1. The class still shows on the document at the same path: nothing.
2. The class shows on the document at a new path: re-path the entry from the
   run's evidence; where its control keeps the old bytes and a fixed entry
   names that directory, retain a new control named
   `<old control name>-after-13` and point the entry at it.
3. The class no longer shows on its document but `reconcile` reports it
   unregistered on another corpus document: change the entry's `document` to
   that one.
4. The class shows on no corpus document: step 2 fixed it. The entry moves to
   the fixed register on its existing control, and the pull request and
   `proof/README.md`'s defect row say that step 2 fixed that part.

The same rule covers a step 2 entry whose document another step 2 fix rewrites
first. The one known case is decided: the 14 `d13-guard-blocks-*` entries
documented on `case-operation-key`, whose root create pull request 6 rewrites
as a keyed create over a repeat one pull request before their own fix. Their
classes stop showing at the root on that document, so pull request 6 applies
the third case and each entry's `document` becomes the one `reconcile`
reports, expected `case-operation-sequence`, the document their control was
retained from (part 05, Order the parts land in). Nothing else about them
changes.

Where the second case applies to defect 25's two entries in pull request 6,
the new control is `container-query-conditional-after-13` (part 05, Shadows
(defect 13) with findings 45 and 47: no `#case/` shadow).

### The entries step 2 adds

| Added | In | Entries | Leaves live | At the exit |
|---|---|---|---|---|
| Finding 52's two classes, restored | 1 | 2, written straight into the fixed register | never live | fixed |
| Work item H | 1 | 2 under defect 3, where the lane shows a class of its own | 6 | fixed |
| Finding 56 | 1 | 2 intent entries (`d56-datetime-ordering-*`) | never in step 2 | **live**, step 3's |
| Finding 57 | 1 | `d57-case-id-column-*`, the classes the first run reports (three expected; part 07, Finding 57: the `case_id` column and attribute-backed hidden carriers) | 11 | fixed |
| Finding 70 (question names HQ's editors warn about; part 08, Finding 70) | 1 | the classes its first run shows, six expected (`targeted-reserved-question-names`, retained as their control) | 10 | fixed |
| Defect 12's explicit tile cell classes, only where pull request 11's run reports them (part 07, Tile cells and finding 42) | 11 | up to 3 (`d12-custom-tile-app-horizontal-align`, `-vertical-align`, `-font-size`), on a new control `targeted-custom-tile-explicit-cells` | 13, with defect 12's other entries | fixed |

At the exit `proof/known-defects.json` holds the 159 entries of defects 20,
21, 23, 24, 25, 26, 27, 28 and 30 (less any the re-homing rule's fourth case
moved) and finding 56's, and nothing else: no entry of a step 2 defect or
finding is held open. `proof/fixed-defects.json` holds 451, finding 52's
two, work item H's two where registered, finding 57's, and defect 12's three
where registered. `proof/controls/` holds the 67 directories less
`nested-menu-previous`, plus `targeted-case-operation-read`,
`targeted-datetime-ordering`, `targeted-case-id-column`,
`connect-location-capture` and the six `-after-13` controls: 76 where work
item H registers its class and finding 52's control shows its two classes;
one fewer for each that does not, and one more for each of the two
conditional controls, `container-query-conditional-after-13` (the re-homing
rule's second case, pull request 6) and
`targeted-custom-tile-explicit-cells` (pull request 11), and for any other
control the re-homing rule's second case retains. Every one is named.

### Entries of the lane's branch for findings 58 to 69 and defect 15's Connect forwarding

The counts above are of `main`'s register at `e7f74de1`. The lane's branch (`proof/run-every-reader`), which the stack is cut over, registers what its new readers showed. For the findings it numbered 58 to 69, correction 15, defect 15's Connect forwarding and the Data Forwarding check, the blocks that own them move or delete these entries, each in the pull request named:

| Finding | Entries | Check and artifact | Control | Outcome | Pull request | Block |
|---|---|---|---|---|---|---|
| 59 | `d59-local-archive-names-no-serve-formplayer-local-ccz-submit-status`, `d59-local-archive-names-no-server-connect-local-ccz-posts-answer`, `d59-android-proof3-local-ccz-readers-formsubmissionhelper-getformposturl-changed` | proof 3: `formplayer@local.ccz`, `connect@local.ccz`, `android@local.ccz` | `targeted-close-conditions`, `targeted-connect-deliver-rename`, `case-capture-followup` | fixed | 3 | part 01, A5. A `.ccz` is made for one project space |
| 60 | `d60-connect-key-names-connect-a-refused-500-keyerror` | proof 3, `connect@A` | `targeted-connect-deliver-key-names` | fixed | 10 | part 08, Finding 60 |
| 61 | `d61-deliver-form-with-a-task-connect-a-visit-rejected` | proof 3, `connect@A` | `targeted-connect-deliver-rename` | fixed | 10 | part 08, Finding 61 |
| 62 | `d62-incomplete-forms-tile-webapps-app-settings-home-tiles-incomplete`, `-screens-tiles-incomplete` | proof 4, `webapps@app settings@*` | `targeted-custom-tile`, `targeted-invalid-question-ids` | fixed | 5 | part 04, Defect 7 and finding 62 |
| 65 | the five `d65-texts-the-local-archive-leav-formplayer-local-ccz-*` | proof 3, `formplayer@local.ccz` | `targeted-close-conditions` (3), `case-list-browse`, `case-list-inline` | fixed | 5 | part 04, Finding 65 |
| 66 | `d66-update-property-order-formplayer-local-ccz-case-update-order` | proof 3, `formplayer@local.ccz` | `workforce-case-operation-sequence` | fixed | 9 | part 05, Finding 66 |
| 67 | `d67-android-proof1-b-update-reopened-session-changed`, `d67-android-proof1-local-ccz-update-reopened-session-changed` | proof 1, `android@B`, `android@local.ccz` | `tile-grouped-one`, deleted with them | deleted, `android_grouped_tile_reopen` | 1 | Finding 67: grouped tiles and a reopened incomplete form |
| 68, filed under defect 20 | the 31 entries on `targeted-supply-point-read` | manifest 1, proof 4 30 | `targeted-supply-point-read` | fixed, by the re-homing rule's fourth case | 10 | part 08, Finding 68 |
| defect 15's Connect forwarding | the five `d15-connect-ids-renamed-connect-b-edit-*` | proof 4, `connect@B-edit@*` | `targeted-connect-deliver-rename`, and `targeted-connect-learn-rename`, deleted with its two | deleted, `connect_block_renamed` | 1 | Connect's own reading of a renamed block |

So these blocks move 44 of the branch's entries to `proof/fixed-defects.json` and delete 7 with two members of `HQ_OWN_REPORTS`. Findings 58, 63, 64 and 69, correction 15 and the Data Forwarding check hold no entry on the branch: 58, 69 and correction 15 are held by reader tests (`proof/formplayer/test_end_of_form.py`, `proof/webapps/test_links.py`; `proof/views/test_location_fixture.py`; `proof/views/test_lookup_upload.py`), 63 and 64 by the lane's own design (`device_archive`, `_needs_cloudcare`), and Data Forwarding by `proof/connect/test_forwarding.py`. Finding 70, numbered by part 08, is planning's and is in "The entries step 2 adds".

## How the harness keeps publishing as Nova publishes

`proof/corpus/publish.ts::capturePublish` does not call `publishAppToHq`: it
composes Nova's client calls against a loopback peer
(`proof/corpus/targetPeer.ts`) and stands in for Nova's database with
in-memory reads, and `proof/corpus/__tests__/publish.postgres.test.ts` holds
that composition to the real `publishAppToHq` over migrated Postgres. Step 2
puts a shell create, source reads, drift, confirmations and ledger reads
inside publish, so the capture moves with it in the same pull requests or the
lane publishes something production does not. No Nova TypeScript runs inside
a proof shard: the capture runs at emission and the shards apply its bytes.

| Change | Pull request | Decision |
|---|---|---|
| The two-import first publish | 3 | A first publish is captured as `create.body` (the shell) and `content.body` (the first update, naming `PLACEHOLDER_APP_ID`), then the update bodies; `proof/observe/publish.py::create` applies both inside the `create` step and state A is what HQ holds after the second (HQ app version 2, 3 after media). Proof 1 therefore never sees HQ's re-minted form ids. While the deployment's baseline origin is `create` the drift comparison reads only `modules` (the shell's exemption; part 01, What the shell create changes), and the captured shell holds none, so the capture's first publish never stops between its two imports. The exact file edits are in part 01, A7. The proof capture, in the same pull request. |
| The layout marker | 1, 3 | A sidecar written from pull request 3 carries `"layout": 2`. A sidecar without it is the legacy layout and is replayed as today: one full `create.body`, the placeholder app id written by `proof/hq/operations.py::with_app_id`, and the assumed profile held before each update. Pull request 1 teaches `proof/checks/corpus.py::_captured` and `::Captured.assumed_source_profile`, `proof/observe/publish.py` and `proof/observe/unit.py::_Unit.create_a` to read the marker and adds the test that a sidecar without it replays exactly as before; pull request 3 writes it. Every control retained before pull request 3 (the 66 that remain of today's 67 and the three pull request 1 retains) stays in the legacy layout for as long as it lives; controls retained from pull request 3 on (`connect-location-capture`, the `-after-13` controls and either conditional control) carry `"layout": 2`. `proof/observe/alignment.py` stays for the legacy ones: a legacy control's B carries other ids than its A. |
| A control's `derived.json` | 5 | Step 2 adds no top-level key: `proof/checks/corpus.py::DERIVED_KEYS` keeps its four (`wire`, `intent`, `lookupTags`, `caseDatabase`) and `Document._derived` keeps requiring exactly those. The two values step 2 adds are fields of `Intent`, inside the `intent` key, written by `proof/checks/intent.py::intent_json` and read as optional by `::intent_from_json`, both added in pull request 5: `sequence` (absent on a control retained earlier: `local_archive_versions` makes no claim on it) and the document's two settings (absent: the pre-fix statement, HQ's settings for none, so `profile_settings` judges the control as today). A later pull request that adds an `Intent` field states, in the same way, what its reader does when a control lacks it. No retained `derived.json` is edited by hand. |
| Pre-upload reads held to HQ's own view | 3, 4, 5, 13 | `assumedSourceProfile` becomes `assumedSource`: every field of HQ's app source a captured body depends on (`doc_type`, `build_spec.version`, `profile` in pull request 3; `translations`, `add_ons`, `langs`, `auto_gps_capture` in 5; `logo_refs` in 13), and from pull request 4 `assumedResources`: what the peer answered for each lookup table and place the publish read. The peer answers each from a model of the target (what Nova last sent, plus what the document's `hq-side.json` says a person saved). For the read after a first publish's create, what Nova last sent is the shell, and the shell's keys are the fixed list `lib/commcare/expander.ts::APP_SHELL_KEYS` (part 01, A3. The publish sequence, holds it by pull request: ten keys in pull request 3, `add_ons` gone in 5, `build_spec` gone in 13, `location_fixture_restore` never there). The peer's assumed shell source is specified against that table: a key the row holds is answered as the shell sent it, `build_spec.version` is always the configuration's, and a key the row does not hold is answered as HQ's default for an app created without it (for `add_ons` from pull request 5 that is the empty map of `models/applications.py::Application.add_ons`, a `DictProperty` with no default, and `CapturedSourceNotHeld` holds the peer's answer to HQ's own read of the shell). Pull requests 5 and 13 each regenerate it with the list. Before the HQ side applies an upload it holds each assumed answer to HQ's own view over the unit's state and refuses the capture otherwise: `CapturedSourceNotHeld` (today's `proof/hq/operations.py::CapturedProfileNotHeld`, renamed in pull request 3) for the app source and a new `CapturedResourcesNotHeld` (pull request 4) for tables and places, each naming every differing field. It reads the app source through `proof/hq/operations.py::app_source`, and tables through HQ's own `fixtures/resources/v0_1.py::LookupTableResource` and `::FixtureResource`. These are values HQ returns as stored, so JSON equality decides. The peer never answers from a body HQ did not confirm. |
| Confirmations | 13 | A corpus document publishes with every confirmation its content needs (`PublishInput.confirm`), as step 1's decision 19 already says of flags. Nova's list reaches the lane as data, since no Nova TypeScript runs in a shard: `proof/corpus/publish.ts::NovaPublishVerdict` gains `planPrivileges: string[]`, what `lib/commcare/planPrivileges.ts::requiredPlanPrivileges` yields for the document as the capture publishes it, written into `verdict.json` (absent on a control retained earlier, which makes no claim). A new test in `proof/checks/test_corpus.py` holds it equal, for every corpus document, to `proof/checks/configurations.py::required_privileges`, which derives the same set from HQ's own model of the exported app through `PRIVILEGE_RULES`; neither function changes. The design is part 03, C2. Plan features: the per-privilege confirmation. |
| The confirmed discard | 4, 5, 14 | For a document that carries `hq-side.json`, the capture runs the production preflight, receives `hq_changed`, and publishes again with `discardRemoteChanges` naming every change the refusal listed with its `observedDigest`; the sidecar records what was discarded. So B and B-edit still land over a person's HQ-side saves, and defect 1's language-code entries and defect 4's entries keep a B to show on until their own fixes. For a document without `hq-side.json`, an `hq_changed` at capture stops the emission and names the document: Nova's own push must never read as a change. From pull request 5 the capture discards only when preflight answers `hq_changed`, and each `hqSide` document states `republish` (`"proceeds"`, `"discards"` or `"stops"`, with `stopCode` for the last; part 04, Defect 4: a republish overwrites values kept in HQ), written into `hq-side.json`: `targeted-hq-side-state` states `"proceeds"` and republishes with no discard, since Nova then owns none of the three values its saves change, and `targeted-hq-side-lookup` states `"discards"`. From pull request 14 `targeted-hq-side-lookup` states `"stops"` with `stopCode: "hq_table_content_unsupported"`. A capture whose outcome differs from the statement fails the emission and names the document. |
| A publish Nova stops | 4, 14 | `StepOutcome` gains a third status, `stopped`, with the failure code, written to `outcome.json`. The unit observes no B for a stopped republish, as for a refused one. `targeted-hq-side-lookup` is the document whose republish stops (`hq_table_content_unsupported`) from pull request 14, and `proof/checks/test_hq_side.py` then holds that HQ's table is what it was. |
| Entropy ordinals | 3, 5 | `proof/corpus/entropy.mts::OPERATION_ORDINALS` changes as part 01, A7. The proof capture, in the same pull request, states: `create` and `republish` no longer feed ids and the rule that draws a later update at an ordinal of its own goes in pull request 3; the local export ordinals stay until pull request 5, when defect 9's fix removes the profile `uniqueid` draw. From pull request 3 the publish path draws no id and from pull request 5 the local path draws none, so the ordinals no longer make defects 1 and 9 visible: they make a regression visible. A change that mints an id per export again draws different values at each ordinal, and proof 1 reports it. The fix shows as equal identities because ids are derived, never because two operations share a seed. The weekly unseeded comparison's expectation becomes "equal, with no identity difference". |
| The local archive's target | 3 | `proof/corpus/publish.ts::localCcz` compiles for the configuration's project space with `PLACEHOLDER_APP_ID`, and the HQ side maps the placeholder to A's id in the archive's runtime URLs before proof 3 compares them. Derived ids make every configuration's ledger and the local archive agree with no choice to make. |
| The version floor | 13 | Every configuration builds at CommCare 2.57.0 (`proof/corpus/configurations.ts`), so the floor passes everywhere and the lane shows nothing of it. It is proven by Nova tests with controlled HQ responses. |
| Mutation kinds | each | A pull request that adds a mutation kind adds its generator to `proof/corpus/editKinds.ts::EDIT_KIND_GENERATORS` (the typecheck fails without one), which rebalances the fixed producers' edit batches (`proof/corpus/editBatches.ts`) and can move another document's B-edit entries. Each new kind lands as early as its feature allows, and the pull request diffs each document's `edit/batch.json` kind as well as `index.json`. |
| Sensitivity effects | each that changes what HQ builds under a flipped gate | Dispatch `proof-lane.yml` on the branch and regenerate `lib/commcare/surface/entries/gates.json` `effects` from that whole fresh run (`python3 -m proof.checks.sensitivity effects`). |

### The retained HQ reads for the drift comparator

The drift comparator is Nova TypeScript; HQ's real `app_source` exists only in
the lane's Python. The capture's model of the source is what Nova sent, so
drift trivially passes at capture, and whether it passes on HQ's real export
is otherwise unproven. The lane therefore retains HQ's real reads, and Vitest
runs the production comparator over them.

- `proof/hq/test_retained_reads.py` (pull request 4, a package test whose
  module names its documents in `DOCUMENTS`) publishes `navigation-base`,
  `search-registration-link` (a form link, so a reference path is exercised),
  `case-list-inline` (media), `targeted-hq-side-state` and
  `targeted-hq-side-lookup` (the lookup table) as Nova's publish leaves them
  and writes HQ's own answers to `<output>/hq-reads/<document>/`:
  `app-source.json`; `app-source-again.json`, a second read in an operation of
  its own, so its form ids differ; one `app-source-after-<save>.json` per
  HQ-side save in the document's `hq-side.json`;
  `app-source-after-settings-save.json` and
  `app-source-after-vellum-save.json`, each after a save that changes no
  value; and, for `targeted-hq-side-lookup`, `lookup-tables.json` and
  `fixture-rows-<tag>.json`. For places it writes
  `<output>/hq-reads/places/locations.json` over places the test seeds with
  `proof/hq/operations.py::seed_location`, since no corpus publish pushes
  places. Part 02, The retained HQ reads (`proof/hq-reads/`), owns this list;
  this section states it again only to place it in the lane.
- The test then compares what it wrote with the committed
  `proof/hq-reads/<document>/` and `proof/hq-reads/places/` byte for byte
  and fails on any difference,
  naming the file. Every HQ input is deterministic from a content key
  (`proof/CLAUDE.md`), so the bytes are the same on every run. A person
  regenerates by copying `.proof/out/blocks/<id>/hq-reads/` over
  `proof/hq-reads/` and reviewing the diff; a pin move that changes HQ's
  export fails here first, in the weekly pin pull request.
- Vitest, in ordinary CI, runs the production normalization and comparison
  over those files (pure; `lib/deployment/__tests__/hqSourceBaseline.test.ts`
  for the app source and `lib/deployment/__tests__/hqResourceBaseline.test.ts`
  for tables and places): two reads of one app are equal after
  normalization; a save of a key Nova owns differs and names the right part;
  a save of a key Nova leaves at HQ's value is equal; and the two no-change
  saves give exactly the verdict the publish stop's copy and the public docs
  state (a save in an HQ editor that changes no value can still stop the next
  publish).

`proof/hq-reads/` holds HQ's answers about the lane's own synthetic project
space only. It is under `proof/`, so it is in the harness fingerprint and a
change to it runs the package groups again.

## Corpus changes

`proof/corpus/emitCorpus.ts::admittedDoc` stops the emission on a document the
strict schema or full validation refuses, so every narrowing rewrites or
removes the documents it refuses in the same pull request.

**The rule.** Each pull request that narrows the validator or changes the
model runs the emission first, with no Docker, at its base and at its head:

```bash
node --conditions=react-server --import ./proof/corpus/entropy.mts \
  --import tsx proof/corpus/emit.ts --out <dir>
```

and reads three things: the stop, if any (the first refused document, by
name); the census of documents the export boundary left out; and the diff of
`index.json`'s document ids. An expander document's id is
`expander-<slug of its first test's title>-<hash of that title>-<index among that test's documents>`
(`proof/corpus/documents.ts::readExpanderCapture`), so retitling a test in
`lib/commcare/__tests__/expander.test.ts`, or changing how many documents it
expands, renames documents that entries,
`proof/rules/conftest.py::DOCUMENTS` and `proof/timings.json` name. An id
that changes is either restored (the test keeps its title and count) or
followed through every one of those. A refused fuzz document means the
generator is changed to stop drawing the shape
(`proof/corpus/fuzzSample.ts::admitted` throws); no entry names a fuzz
document.

Documents the step adds, changes or removes:

| Pull request | Change | Document | After the change | Control that keeps the pre-fix bytes |
|---|---|---|---|---|
| 1 | lane mechanics | `targeted-hq-side-state` | Split. It keeps the UI translation, app setting and build profile saves. Its `hqSide.lookupTable` moves to a new `targeted-hq-side-lookup` (`proof/targeted/documents/hqSideLookup.ts`), and the seven `d5-table-content-*` entries take that `document` and keep `control: targeted-hq-side-state`. Reason: defect 5's refusal is the one stop with no discard, so nothing else may share its republish. | `targeted-hq-side-state` |
| 1 | new witnesses | `targeted-case-operation-read`, `targeted-datetime-ordering`, `targeted-case-id-column` | Added. | their own, retained in pull request 1 |
| 3 | wire codes | `localization-mandarin`, `targeted-hq-side-state` and every document with a language | Sources gain `localization.wireCodes`; `localization-mandarin` is re-authored so its removal keeps the other language's code. | `targeted-hq-side-state` |
| 5 | `appSettings` | every document | The fixture helper states the two settings; bytes change, ids stay. | `case-operation-query` |
| 5 | finding 34's control | `targeted-invalid-connect-ids` | Unchanged as a document. The pull request's first commit retains the control `connect-location-capture` from it, before defect 4's judge change and any emitter change, and `d34-connect-location-trace-meta-location` takes that control. | `connect-location-capture` |
| 6 | root create id | `case-operation-key` and any document whose root create is keyed by an answer | Rewritten as a keyed create over a repeat. Its 14 `d13-guard-blocks-*` entries are re-documented in pull request 6 on the document `reconcile` reports (re-homing rule, third case; expected `case-operation-sequence`). | `case-operation-key`, `case-operation-sequence` |
| 6 | blank translations | `localization-optional` | Source unchanged: no content is deleted and no migration runs; the emitter fills. Its five entries leave, and it stays the document of `d41-empty-list-text-app-no-items-text` until pull request 11. | `localization-optional` |
| 6 | `#form/` defaults, shadows, datetime leaf | `targeted-load-time-values`, the `container-query-conditional*` and `case-operation-*` producers | Bytes change; ids stay. | named by their entries; `container-query-conditional-after-13` only where a defect 25 path moved |
| 7 | rename and groups | every document that emits a generated node | Bytes change; ids stay. | the old directories, and six new `<old control name>-after-13` controls |
| 9 | case writes | every registration, follow-up and close form; `targeted-close-conditions`, `targeted-close-condition-unparsable` | Bytes change. The two targeted documents stay admitted and turn from symptom to witness. | same names |
| 10 | question, entry-point and Connect ids | `targeted-invalid-question-ids` | Rewritten in place as the migrated shape: the positive witness that Vellum and the form settings save accept it. | same name, 12 fixed entries |
| 10 | same | `targeted-invalid-connect-ids` | Rewritten in place, still a Connect app. Finding 34's entry on it is already fixed in pull request 5. | `connect-location-capture` |
| 10 | `instance`, `bind`, `parsererror` | `targeted-reserved-node-names` | Rewritten in place as the migrated shape. | same name, 5 |
| 10 | duplicate option values | `expander-select-option-itext-ids-index-keyed-issue-10-608c801a-0`, `-bf790763-0` | Their tests become refusal tests, so both documents leave the corpus: the `index.json` diff must show exactly those two ids removed. Removing two documents rebalances the fixed producers' edit batches, so an entry the full lane then reports unseen on its document is re-documented on the document that shows it. Control names are free (`proof/checks/corpus.py::load_controls` takes the directory's name). | same names |
| 10 | a form of empty groups | `expander-empty-container-expansion-emits-an-empty-group-86a5cfc1-0` | The test keeps its title and its form gains a question, so the document keeps its id and changes bytes; the `index.json` diff must show no id added or removed by this change. The document then shares its name with the control, which keeps the pre-fix bytes. | same name |
| 11 | case-list order plan | the `expandDoc HQ JSON projection sort elements` tests' documents | The tests keep their titles and document counts, so the three ids `proof/rules/conftest.py::DOCUMENTS` and the entries name survive until their rules and entries leave in this same pull request. | `...-sort-elements-5899296f-0`, `...-keeps-67fa0ac7-0`, `...-85a51a04-0` |
| 11 | `CASE_LIST_SORT_PROPERTY_AMBIGUOUS`, `CASE_TILE_HIDDEN_CALCULATED_SORT`, ID-mapping key characters, date patterns narrowed to HQ's five, required tile cell slots | `targeted-shared-property-sort`, `targeted-custom-tile`, the `tile-*` documents, `workforce-tile-persistent`, every producer with a date column outside the five patterns | Whatever the emission refuses is rewritten as the shape the cutover's transform yields for it: a tile producer whose hidden order rule sits on a calculated column, or on a column over `case_id`, `owner_id` or `status`, loses that rule; tile sources gain `horizontalAlign`, `verticalAlign` and `fontSize`; a date column outside the five becomes a calculated column. Ids stay, bytes change. | `targeted-shared-property-sort`, `targeted-custom-tile`, `tile-grouped-browse` |
| 11 | witnesses | `targeted-hidden-column`, `targeted-label-sort`, `targeted-case-id-column` | Stay admitted; their `expected.json` values pass with no entry. | same names |
| 11 | new witnesses for the shapes that rest on reading | `targeted-attribute-columns` (`proof/targeted/documents/caseIdColumn.ts`), `targeted-hidden-calculated-column` (`proof/targeted/documents/hiddenColumn.ts`), `targeted-tile-hidden-order` (`proof/targeted/documents/customTile.ts`) | Added, each a passing document with no entry and no control. Part 07 defines them, in Finding 57: the `case_id` column and attribute-backed hidden carriers, Hidden columns: defect 16's column half, findings 35 and 36, and The corrected tile clause. | none |
| 11 | explicit tile cells | `targeted-custom-tile` under its `CASE_LIST_TILE` configuration | Only where the run reports defect 12's save dropping the three keys Nova now writes: three `d12-custom-tile-app-*` entries are added on a new control retained from this pull request's bytes. | `targeted-custom-tile-explicit-cells`, conditional |
| 12 | `POST_SUBMIT_NOT_OFFERED` | `targeted-multi-select-destinations` | Rewritten in place with the migrated destinations. Its defect 1 and 9 entries are already fixed. | same name, `case-operation-query` |
| 12 | same, by the default | `case-capture-multiple`, `case-extension-multiple`, `nested-menu-same-multiple` and every multi-select producer | Stay admitted: the default destination changes, so bytes change with no source edit. | `case-capture-multiple` |
| 12 | same | `targeted-form-links-hidden-and-fallback` | Unchanged and admitted: a fallback beside form links is exempt until step 5. | same name |
| 12 | the search button label leaves the model | `targeted-search-button-label` | Deleted, with `proof/targeted/documents/stableWitnesses.ts`'s note and the `proof/README.md` paragraph that says it owns three classes. Its three entries become fixed entries. | `case-operation-query` |
| 12 | same; reserved input names | `targeted-search-hq-compile`, `lib/commcare/__tests__/searchEmissionFixture.ts`, any `expander.test.ts` case that sets the label | The slot and the reserved inputs leave the source; the document stays for defects 6 and 48. | `targeted-search-hq-compile`, `case-operation-query` |
| 12 | an input named like a default filter | `targeted-search-default-filter-name` | Rewritten with the suffixed name. | same name, 3 |
| 12 | `hiddenFromMenu`; survey menus | `targeted-survey-menu` and any document whose display condition is or starts with `match-none` | The survey document stays a witness; a refused condition is rewritten as `hiddenFromMenu` with its rest. | `targeted-survey-menu` |
| 12 | new witness for `hiddenFromMenu` | `targeted-hidden-from-menu` | Added, a passing document with no entry and no control. Part 06, 11. `hiddenFromMenu`: a menu or form that is not on the menu, defines it. | none |
| 13 | the tile gate | `targeted-custom-tile` | Its source drops the `CASE_LIST_TILE` named configuration (`proof/corpus/entryWriter.ts` throws for a configuration the verdict refuses). | same name keeps `export/CASE_LIST_TILE` |
| 13 | related lookups | `targeted-search-related-lookups` | Its minimum configuration gains the flag; it stays a witness. | same name |
| 13 | single-date prompt | `navigation-search-day-range` | Its minimum configuration gains `CASE_SEARCH_ADVANCED` from the probe plan, with no source edit; it stays a witness. | `navigation-search-date-add` |
| 14 | time ordering | `targeted-time-ordering` | Deleted: no admitted document can order a time, so nothing remains to witness. The refusal and its accepted neighbour are the validator's tests. | same name, 3 |
| 14 | CSQL refusals, finding 48 | `targeted-search-hq-compile` | Its last edit: the refused comparisons become their migrated shapes, and it stays as the witness that every CSQL string it sends compiles on HQ with no entry. | same name |
| 14 | reserved tags | `targeted-lookup-reserved-tags` | Rewritten with the tags the cutover's rename yields; its value-level expectation then proves the select reads the table. | same name, 2 |
| 14 | table content | `targeted-hq-side-lookup` | Its `republish` statement becomes `"stops"` with `stopCode: "hq_table_content_unsupported"`; its republish stops and the lane records the stop. | `targeted-hq-side-state` |
| 14 | hint media, group and repeat label media, validation-message media leave the model | `media-rich` (named by `proof/hq/test_branches.py::DOCUMENTS`) and any other source that sets them | The slots leave the source; the id stays. `proof/checks/manifest_value_classes.py`'s protected-message reader stops expecting the `__nova_mode;<medium>` forms in the same pull request. | `case-operation-sequence` |
| 14 | the Hidden Value | every document with a bare hidden value | Bytes change; ids stay. | none needed |

A control holds no `document.json`, so a migration test that needs a pre-step
document takes it from the frozen pre-step fixtures pull request 2 commits,
never from a control.

Python that reads Nova's document shape moves with each model change it
reads: `proof/checks/intent.py::document_intent` and `::profile_settings`,
`proof/observe/casedata.py::case_database` (in the observation partition, so
a change re-keys every record) and `proof/checks/proof1.py::lookup_tags`.

## How the exit is checked without a third HQ state

The lane observes A and one next publish (B, with B-edit as an alternative
next publish). It never observes a publish over B, and step 2 does not add
one: a third state for every document and configuration would add an update,
a build, an admission and an identity read to all 345 corpus groups, for a
claim the four checks below already close.

| Exit clause | Checked by | Boundary |
|---|---|---|
| "keeps every `xmlns`, form id and module id in HQ" across a republish | Proof 1 on every corpus document with no defect 1 or 9 entry left: A against B, A against B-edit | the lane |
| the second republish | `proof/corpus/publish.ts::capturePublish` captures the republish twice, the second from the target state the first left, and requires the two import bodies byte equal (`::sendsTheSame`); a difference stops the emission and names the document. HQ has then already applied those exact bytes once | emission, every document and configuration |
| an ordinary update writes ids back as a create did | `proof/hq/test_publish_capture.py`: the same captured update applied twice leaves every identity record as the first application left it, over the documents `proof/hq/test_branches.py::DOCUMENTS` names | native proof |
| the ledger across three publishes | `proof/corpus/__tests__/publish.postgres.test.ts`: the real `publishAppToHq` run three times sends, on the second and third run, the ids the first sent; the ledger rows are unchanged by the second and third; and the capture's request sequence, each read included, is the one the real publish makes | real Postgres, controlled HQ responses |
| "every `xmlns` in the local `.ccz`" | Proof 1's local path (two exports of D) and proof 5 (forms outside an edit's footprint between `local.ccz` and `edit/local.ccz`) | the lane |
| "proofs 1 to 5 pass on every Nova export for these defects" | The gate, on every pull request | the lane |
| "the register holds no entry for defects 1 to 10, 12 to 16, or 31 and up except finding 56" | `proof/checks/test_registers.py::test_every_live_defect_is_a_later_steps`, added in pull request 15: every live entry's defect is a key of `registers.OPEN_DEFECTS`, which maps each open defect to the step that owns it (20 to step 4; 21, 23, 24, 25, 26, 27, 28 and 30 to step 5; 56 to step 3). Registering any other defect later means adding it there with its step. Finding 56 is the only key from 31 up: `OPEN_DEFECTS` holds no entry for finding 40 or for any other step 2 finding, and the exit has no conditional exception | native proof |
| each emptied class still seen | The gate's register section: every fixed entry held on its control | the lane |
| "publish refuses a target below the floor or without a confirmed privilege; a second publish stops when HQ's copy changed" | Nova's deployment tests, named in part 02, Work item B, the standard block, and in part 03, C1. The version floor, and C2. Plan features: the per-privilege confirmation | real Postgres, controlled HQ responses |

## The lane's cost, and the local runs that prove each kind of fix

Measured today (`proof/timings.json`, 10 shards on `ubuntu-24.04-arm`, four
workers each): 1,940.7 box-seconds, of which the 345 corpus groups cost
1,477.6, the 66 control groups 264.6, and the packages and surface 198.5. The
29 targeted documents cost between 1.2 and 9.3 box-seconds each.

What step 2 adds and removes:

| Change | Cost |
|---|---|
| The second import of every first publish (pull request 3) | One more HQ update per document and configuration in every A. |
| Eight new targeted documents: `targeted-hq-side-lookup`, `targeted-case-operation-read`, `targeted-datetime-ordering` and `targeted-case-id-column` (pull request 1), `targeted-attribute-columns`, `targeted-hidden-calculated-column` and `targeted-tile-hidden-order` (pull request 11), `targeted-hidden-from-menu` (pull request 12); two leave (`targeted-search-button-label` in 12, `targeted-time-ordering` in 14) | Each about its own group, within the targeted range above. |
| Three new controls (pull request 1) and `connect-location-capture` (pull request 5) | Each about its own group, within the same range. |
| Six `-after-13` controls (pull request 7), finding 52's control running again, and either conditional control (`container-query-conditional-after-13`, `targeted-custom-tile-explicit-cells`) where retained | About what their source documents' controls cost today. |
| `proof/hq/test_retained_reads.py` | Five documents published once and a few places seeded, inside the `proof/hq` package group. |
| The fixed register | No new groups beyond finding 52's: the same controls keep running, and a control's records are reused from the evidence store while its files and the observation fingerprint are unchanged. |
| Retired rules and moved entries | Nothing. After defect 1's fix A and B build alike for most documents, which lowers proof 3's replays on B. |
| A third publish per document | Not added. |

Most pull requests of the stack run close to the full cost: an emitter change
moves almost every document's export bytes, so its corpus groups run cold,
and a change under `proof/observe`, `proof/hq`, `proof/lane` or `proof/store`
re-keys every record, controls included. That is the designed worst case (the
nightly audit and the pin prewarm run it), not a new one. Each harness change
is measured as `proof/CLAUDE.md` requires, in CPU-seconds of the harness's
and Postgres's containers per document, and pull request 15 refreshes
`proof/timings.json` from hosted runs (`node proof/run.mjs --timings`). The
shard count stays 10 unless three hosted runs per candidate say otherwise;
where they show the lane cannot finish inside the five-minute target, the
pull request records them and the person sets the target (step 1's
decision 11).

Local runs on a 16 GB Mac use one worker, the default. Emit one corpus on the
host and reuse it across runs (`PROOF_CORPUS=<dir>`), then select:

| Kind of fix | What the pull request runs locally |
|---|---|
| An emitter spelling a proof 4, 3 or 2 entry holds | `npm run proof -- proof/checks -k <document id>` for the two or three documents the entries name, then `-k control-<control id>` for each control: the document must pass with the entries gone, the control must still show them. |
| A validator narrowing or a model change | No Docker: the validator's own tests (refusal and accepted neighbour), `proof/targeted/__tests__/targeted.test.ts`, and the emission at base and head for the stop, the census and the `index.json` diff. Then the lane on each rewritten document. |
| Publish and identity | `npm run proof -- proof/hq/test_publish.py proof/hq/test_publish_capture.py`, the lane on `targeted-hq-side-state` and one ordinary document such as `navigation-base`, and `publish.postgres.test.ts` under Vitest with Postgres. |
| Drift | `npm run proof -- proof/hq/test_retained_reads.py`, then `hqSourceBaseline.test.ts` and `hqResourceBaseline.test.ts` under Vitest over `proof/hq-reads/`. |
| A retired rule | `npm run proof -- proof/rules`, which needs the documents `proof/rules/conftest.py::DOCUMENTS` names in the corpus. |
| A judge change | The judge's own test, then every control the changed check runs on (`npm run proof -- proof/checks/test_<check>*.py -k control-`). |
| The registers | `npm run proof -- proof/checks/test_registers.py proof/lane/test_gate.py proof/checks/test_controls.py`, then `python3 -m proof.lane.gate .proof/out`. |
| Sensitivity effects, and anything that needs one whole fresh run | Dispatch `proof-lane.yml` on the branch, which is free. |

CI's full lane is the proof of each pull request; the local runs find the
failure before it.

## What the two documents say when step 2 ships

Pull request 15 leaves `proof/README.md` and `proof/CLAUDE.md` describing the
lane as built, with every fix's pull request having already changed the
passage it made false.

`proof/README.md`:

| Section | Says, from step 2 |
|---|---|
| Opening | The lane passes when every difference is erased by a proven spelling rule or held by a known-defect entry, every known-defect entry still shows on its document and its control, and every fixed-defect entry still shows on its control. |
| "A, B and B-edit" | A first publish is a shell create and an update; state A is HQ app version 2; ids are derived; a document with `hq-side.json` republishes as its `republish` statement says (it proceeds, it goes through after the discard a person would confirm, or Nova stops it); a publish Nova stops leaves no B. |
| "The bar" | A refusal of either import of a first publish is reported under its own artifact. |
| "Proofs 1 to 5" | Proof 1: `identity-moves.json` is empty and why. Proof 3: a submission's version across the two paths is each path's own counter. The closed set `proof/checks/hq_own_reports.py::HQ_OWN_REPORTS`, its three members (proof 4's Vellum alert, proof 1's Android reopen of a grouped-tile session, and the Connect judge's renamed block), the check that reads each, and how to add another. |
| "What the lane does not observe" | Loses defect 3's clause and the closing paragraph about step 1's open clause (pull request 8). Says the version floor, the confirmations and the drift verdict on a live target are Nova tests, and that the drift comparator is proven over the retained reads. |
| "Emitting it" | The ordinals keep a regression visible; no id is drawn on either path. |
| "The layout on disk" | `create.body`, `content.body`, the `layout` marker, `assumedSource` and `assumedResources`, `outcome.json`'s `stopped`, and the legacy layout controls keep. |
| "Configurations" | Each document publishes with the confirmations its content needs. |
| "Targeted documents" | The eight new documents (the four of pull request 1, `targeted-attribute-columns`, `targeted-hidden-calculated-column`, `targeted-tile-hidden-order` and `targeted-hidden-from-menu`) and the two removed (`targeted-search-button-label`, `targeted-time-ordering`); `targeted-search-button-label`'s paragraph goes. |
| "The registers" | A new subsection, "Fixed defects": the file, the entry, the eight rules, the repair rule, and that a control runs while an entry of either register names it. "Known defects" says a fix moves its entry. |
| "The defect rows" | Rows for defects 1 to 10 and 12 to 16 say fixed in step 2 and name the control that still shows each; rows for findings 56 and 57 are added; any part the re-homing rule's fourth case moved says so. |
| "Adding a register entry and its control" | Gains "Moving an entry when its defect is fixed", the `--as` argument, and "never retain a directory a fixed entry names". |
| "Identity moves" | Stays empty, with the reason, and says a step's one-time changes for existing deployments are held by its cutover's tests and notices. |
| "Spelling rules" | 24 rules; `profile_unread_properties` covers `app.json`. |
| "The evidence store and its audits" | The judge's code includes the three registers; the weekly unseeded comparison expects no identity difference. |
| "How the harness proves itself" | The "publishes as Nova does" row names the three-run test and "an update applies only over the source it was built from"; a row for the retained reads; a row "every control is named". |
| "Changing a pin" | The repair rule for a fixed entry a pin move breaks, and regenerating `proof/hq-reads/`. |
| "Step 1's decisions" | Decision 12 names both registers; decision 13 says the register is empty by design; decision 14 names the shell create and the legacy layout. The closing paragraph no longer calls a clause open. |

`proof/CLAUDE.md`:

- The determinism rule's clause "the ordinals keep defects 1 and 9 visible"
  becomes "the ordinals keep apart what a regression would mint apart".
- The register rule reads: "A fix moves its entries to `fixed-defects.json`
  in the same pull request, where each must still show on its control and is
  held on no document. A fixed entry is re-pathed only when the check's
  vocabulary or pinned upstream text moved, deleted only when upstream changed
  the behavior or a judge change deliberately stops reporting the class, and
  its control is never retained again." The sentence "Never skip, mark,
  loosen a comparator or widen a path to make the lane pass" stays, followed
  by "what HQ's own editors, CommCare's runtimes or Connect report on an app
  Nova never touched is dropped only by a member of `HQ_OWN_REPORTS`, a closed
  set whose every member has a proof that runs that reader's own code over an
  app made in HQ's own editors, as a spelling rule has".
- A new rule: "The capture moves with publish. A change to what
  `publishAppToHq` reads or sends changes `proof/corpus/publish.ts` in the
  same pull request, the peer answers a read only with what the HQ side then
  holds to HQ's own view, and retained controls replay the layout they were
  captured in."
- The opening paragraph's list of what `proof/README.md` explains gains "how
  a fixed defect's control keeps running".
