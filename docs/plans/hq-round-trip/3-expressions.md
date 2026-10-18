# Step 3: Expressions

Step 3 replaces Nova's two stored expression vocabularies with one typed `Expression` union, so no
expression slot stores a reference as text. It fixes finding 56 (a date and time never orders by
instant on a device), finding 75 (an equality on a date and time compares text on HQ), defect 17
(relative paths and case queries stored as text) and the two walk stops step 2 left to it
(findings 72 and 73). It ships as one stack of fifteen pull requests, one maintenance cutover and
one deploy.

This file is the plan. It holds the baseline the plan was written against, every decision that
departs from the outline it replaces or from the research, the work items with where each is
planned in full, the stack, the cutover, the contracts and the exit. The detail (schemas, files,
register entries, tests, copy) is in ten part files beside it,
[`3-expressions/`](3-expressions/). A session implementing one pull request reads this file, that
pull request's row and its file list in part 10, and every part the row names. Nothing here or
there is left to decide during implementation. Every claim about what a CommCare reader does with
Nova's export was read at the pins or observed during planning, and where a fix's outcome mattered
to the plan, its bytes were written and run; "Written and not yet run" below lists every place
where a run is outstanding.

| Part | Holds |
|---|---|
| [01](3-expressions/01-model.md) | The typed model: the `Expression` union and every arm, the mapping from every JavaRosa construct to its arm, the canonical print of each arm in each grammar, two-axis types, slot profiles, identities on rename, move and removal, Zod and the served schemas |
| [02](3-expressions/02-authoring.md) | Authoring: the form-XPath parser, the record dialect, what the model is taught, the builder (editor, linter, chips, cards), the reference index and renames (defect 17), every consumer that re-parsed text |
| [03](3-expressions/03-checker.md) | The one type checker, its two rule sets, where every validator rule over expressions goes, the new refusals (finding 72 among them), writer agreement (finding 73's authoring half), Hidden Value inference |
| [04](3-expressions/04-emission.md) | Emission: the wire XPath tree and its one serializer, finding 56's instant lowering, the day rule for system dates on a device, canonical bytes, HQ's form builder and interpolation |
| [05](3-expressions/05-instances-session.md) | Session datums as held identity; typed instance references: case queries, data tables, flat locations, selected cases, an inline search's results; their declarations and manifest rows |
| [06](3-expressions/06-csql.md) | Typed CSQL composition: the position model, every construct the research names, `today()` as the worker's day, finding 75's HQ half, the fold Preview and Postgres read |
| [07](3-expressions/07-preview-case-store.md) | Preview on the device's own XPath, Preview's Core mismatches, what Preview supplies for every new read, finding 73 in Preview, the Postgres compiler over the union |
| [08](3-expressions/08-proof.md) | The proof: native families and zones, the registers and walk stops, the corpus and the fuzz generator, the CI cost model and the reader runs |
| [09](3-expressions/09-cutover.md) | The cutover and its notice: the fold horizon, the lift, the ordered steps, declarations and the case store, the census, the runbook |
| [10](3-expressions/10-stack-contracts.md) | The stack in full with files by pull request, house rules, the model-addition checklist, every contract and docs sentence that changes, the nova-plugin check, the exit |

## The baseline this plan was written against

**Nova.** `main` at `5cf6e327`, which is step 2's sixteen pull requests (#749 to #767) merged and
its cutover run on production. Step 2 changed no stored expression vocabulary: the two families
step 3 replaces are as the research describes them, `Predicate` / `ValueExpression` / `Term`
(`lib/domain/predicate/types.ts`) and the text-with-leaves `XPathExpression`
(`lib/domain/xpath/ast.ts`, leaves `text`, `field-ref`, `path-ref`, `case-ref`, `user-ref`,
`user-property-ref`, `search-answer-ref`). What step 2 moved that step 3 builds on:

- **The time-of-day ordering refusal** (defect 6, #765) is two readers: `time-ordering` in the
  record checker (`lib/domain/predicate/typeChecker.ts::ORDERED_TYPES`) and `XPATH_TIME_ORDERING`,
  a reader over printed form-logic text (`lib/commcare/validator/timeOrdering.ts`), which the editor
  places through `orderingSpans`. Step 3 makes them one rule of the one checker over the stored
  tree, and the editor places findings by parse spans (parts 02, 03).
- **The three system dates in CSQL** (`lib/domain/standardCaseProperties.ts::SYSTEM_DATETIME_CASE_PROPERTIES`)
  and the **blank-comparand runtime guard** (`lib/commcare/predicate/runtimeCsqlDateSafety.ts`) carry
  over as obligations of the position model; `closed_on` becomes readable in the one slot no device
  evaluates (part 06).
- **The both-quote-marks `'match-none()'` sentinel** (finding 48) stays the one sentinel, with
  whole-clause scope, for every typed obligation (part 06).
- **`xpathQueryUsesRelatedLookup`** reads what the CSQL emitter writes; it stays correct by
  construction when step 3 writes the flag-free `parent/@case_id` spelling (part 06).
- **`lib/domain/caseListOrder.ts`** and the mapping-position sort key: a calculated column's printed
  text is HQ's `field` and the sort's join text, so canonical print moves it once, inside the
  census; `caseListOrderOptions` stays the one source of its text and type (parts 04, 07).
- **`lib/domain/questionId.ts`** (`QUESTION_ID_PATTERN`): every name step a relative path can name is
  letter-first, so the parser resolves every relative step through the grammar to field identity,
  and the cutover's lift refuses (blocks) one that resolves to no field (parts 02 §1, 09 §11).
- **`hiddenFromMenu` and the post-submit destinations** (#762): the display condition is held as
  written, `DISPLAY_CONDITION_USE_HIDDEN_FROM_MENU` keeps its verdict over the union, and its rule
  file moves to the one checker in pull request 5; a form link's condition and datum values keep
  their print (parts 03 §2, 05 §1).
- **Finding 56's register entries and control** (`targeted-datetime-ordering`, two live entries
  under step 3) and **the walk stops of findings 72 and 73** (six in `proof/walk-stops.json`): step
  3 moves the first and removes the second (part 08).

Since step 2 merged, the lane's nightly with every reader has failed in the Android reader's runtime
job (#768). Its proof-side fix is #771, stacked on this plan's pull request and merged with it; the
reader runs below ran with it beneath.

**CommCare.** Every fact this plan relies on was read, and where reading left doubt executed, at
the commits `proof/pins.json` names, unchanged since step 2: commcare-hq `d6c6e16d8ae1`,
commcare-core `8e9ba8d908e9`, commcare-android `7a5584475580`, commcare-connect `046c7fd78081`,
formplayer `24383ac71bfb`, and Vellum `01215f251c57`, the build HQ vendors at that pin. Citations
are `file::symbol`.

**Executed during planning.** Each part's "Executed during planning" gives the run, its command and
what it showed; the runs that decided the plan:

- **Finding 56's lowering on Core.** A zone-free parse of instant text into integer microseconds,
  written in XPath's own string functions, orders every pair by instant in four device zones
  (`UTC`, `America/New_York`, `Asia/Kolkata`, `Pacific/Kiritimati`) and three Formplayer-like setups,
  131 of 131 rows identical, a daylight-saving fall-back pair right and thirteen offset spellings
  equal, after one fix found by the run (text with no offset and a fraction read NaN until the offset
  read was guarded). Each zone needs its own test JVM; `GRADLE_OPTS` does not reach it (parts 04, 08).
- **Preview against Core** for every operand in every zone: equal for text, and for typed answers
  but inside a repeated daylight-saving hour, which part 07 fixes, with two `format-date`/`date`
  rounding mismatches.
- **HQ's search and a datetime.** HQ's receiver rewrites every datetime-shaped value before it is
  indexed (`form_processor/utils/xform.py::adjust_datetimes`), so a CSQL range compares instants
  for any spelling, while CSQL `=` on a custom datetime property is text equality: an instant
  spelled any other way finds nothing. That is finding 75, new (part 06).
- **Two read-only production scans** over every live app, content-free, the second under the
  person's standing permission for read-only production reads. They decided which lifts, refusals
  and blockers the cutover meets; as in step 2, no count from production enters this plan. Each
  part says what production holds where it decides something, and the cutover's dry run counts
  again at the window (part 09).
- **Lane runs on GitHub's runners without the served readers**, on scratch branches cut from `main`
  and never merged: the two new targeted documents before any fix, `targeted-datetime-equality` in
  the scratch branch's version (a date-and-time question in "Log visit", a third case list on
  `date_opened`). The differences that version showed on "Visits" and "Other visits", and
  `targeted-datetime-operands`' intent and manifest differences, are seven of the eleven entries
  pull request 1 registers (part 08 §6.4, §7). And a document of every form spelling step 3 reads, through two HQ form builder saves, which showed that Vellum's
  only rewrite of canonical text is spacing Nova's canonical print now writes itself (parts 01, 04).
- **Host emission of the whole corpus** at base and head for finding 72's mapped defaults and
  finding 73's catalog-seeded case data (part 08 §3.3, §4.4).
- **Reader runs on GitHub's runners**, the second dispatches, with issue 768's fix beneath each
  scratch change (part 08 §6.4). R2 (run 39064333759) held with every reader over the spellings
  document: Formplayer, the Web Apps client and Android read every form spelling step 3 relies on,
  and the lowering, as Core does. R3 and R4 (run 39064336028), over the 26 documents the select
  default map and the catalog seeding move, with the six walk stops of findings 72 and 73 removed:
  no opened form reaches a reader's own end, so the removal holds with every reader. The run showed
  two things pull request 5 carries. The Formplayer walk sends a value the question already holds,
  where the Web Apps client sends nothing, which five documents' new opening values expose; that is
  a gap in the harness's walk model, which pull request 5 fixes in `proof/formplayer/walk.py`. And
  one document shows a knock-on of defect 21 once its form opens, which pull request 5 registers
  as two live entries under defect 21 on a new targeted document, `targeted-list-first-places`,
  since the register refuses an entry on a fuzz document (part 08 §3.3). R1 (run 39064331941)
  showed on its first shard every served reader reproducing finding 56's literal case-list half,
  and nothing unregistered but the manifest classes pull request 1 registers; its second shard lost
  its runner, and R1 run 39078199859 read that shard's three documents with every reader.
  `targeted-datetime-equality`, as this plan writes it, shows finding 75's two device-half entries
  on document and control and meets no finding 74 stop. And HQ's search for "Opened visits", a
  `date_opened` equality with the builder's minute-precision literal, answers 500 because
  Elasticsearch refuses the raw term: Formplayer's walk stops there on every state, and proofs 3
  and 4 show four classes of difference from that one error. Pull request 1 holds them in one walk
  stop and four live entries under finding 75, and pull request 10's closed instant range moves
  them to the retained control (part 06 §3.13, part 08 §3.2). Runs 39064336028 and 39082895745
  (#771's) showed a lane-mechanics fault unrelated to step 3, the renamespacing check filed under a
  document no dispatch over named documents runs, which pull request 1 fixes (part 08 §7 item 10).

**Written and not yet run.** Each part states its design as the plan's and says in place where a
run is outstanding; this list is every such place.

- **R5** runs at pull request 5's branch, over the new fuzz generator's documents,
  `targeted-expression-renames`, `targeted-session-reads` and `targeted-list-first-places`, and,
  with the walk model fixed, over the five documents of its gap (`fuzz-xform-20260930-0`, `-3`,
  `-4`, `-9` and `fuzz-suite-20260930-5`), whose Android, Connect and B and B-edit observations
  run 39064336028 did not reach, and `fuzz-suite-20260930-8`, where defect 21's two new entries
  hold.
- **The closed instant range on HQ's search** (part 06 §3.13) was read, not executed; the `csql`
  native family's `datetime-equality` scenario executes it in pull request 10 before the emitter
  changes, and holds the text equality of finding 75's HQ half, which no lane check compares.

## What changed from the outline, and why

The outline fixed the step's scope. Planning it against the code as it stands changed these. Each
is a decision; the part named gives its evidence.

**Decided with the person (2026-10-17).**

1. **One union, record arms kept.** Today's `Predicate`, `ValueExpression` and `Term` arms stay arms
   of the one `Expression` union with their stored bytes, and the union gains a total XPath core:
   typed calls for the 60 JavaRosa functions no arm means, `negate`, `quotient`, typed instance
   nodes and an identity leaf for every reference. Form-logic text parses into the same union (part
   01).
2. **Canonical print.** The stored tree prints one canonical spelling; no source trivia is stored.
   Text read back in the builder and in tool reads is canonical, and an existing form's bytes may
   change spacing once at its next publish (parts 01, 04).
3. **Planning executes**: read-only production scans, local native Core runs, lane slices without
   readers, and reader runs on GitHub's runners (this file, "Executed during planning").
4. **The catalog's `required`, `validation` and `validation_msg` XPath slots retire.** They have no
   runtime; the cutover removes the stored values and the notice names each (parts 01, 09).
5. **CSQL `today()` is the worker's day everywhere**: emitted as Core's `today()` in a runtime
   segment, so the device filter, HQ's search and Preview agree. Search bytes change once at the
   next publish (part 06).
6. **Deferrals only with a reason.** A construct leaves step 3 only when it needs a model concept a
   later step owns or the platform declaration. Under that rule step 3 keeps search results read in
   an inline-search module's forms and the chosen case in record slots (item 17), and defers these,
   each written into the receiving step's outline file by this plan's own pull request (part 10,
   "Written by this plan's own pull request"):
   - to step 4: search inputs read in an inline-search module's ordinary forms (the read throws on
     Android); the `device-query` datum kind (Android only); authoring of the session context
     fields `drift`, `window_width` and `applanguage` (their values differ by platform);
   - to step 5: `closeCondition.answer` as a choice, and a durable record of a search's claim (both
     are case-write concepts step 5 owns);
   - to step 6: `project-day` (no API-key route reads a project space's timezone, so no surface can
     author it truthfully); several `_xpath_query` rows and recognising the lowered comparison on
     import; arbitrary `<output value>` expressions and `instance(…)` reads in prose; `call` in
     record slots, whose Postgres compilation import owns (only an imported calculated column
     needs one);
   - to step 7: `groups` / `group-field` to group 2 (the read means case-sharing groups, which Nova
     holds only from `caseSharing`, and HQ's own groups are target state Preview cannot show);
     sorting a case list by a date and time and the `date()` guard in generated interval columns to
     group 4, whose sort settings and column kinds own their HQ spelling; the search results
     instance name to group 5; computed datums to group 6.

   Nova does not author HQ's escape hatches because HQ has them: runtime lists (`unwrap-list`) and
   case, lookup and location reads inside a record CSQL value are held in the union, emitted,
   folded and proven so an imported app keeps them, and a person builds the same intent with Nova's
   own arms (a fixed list is `in`).
7. **One stack, merged together**, with the lane mechanics at its bottom.
8. **Read-only production reads** are allowed whenever planning needs one, content-free.

**Decided in planning.**

9. **`call` holds only functions no arm means**; sixteen function names map to record arms, and the
   parser maps by shape, never by idiom (part 01 §2).
10. **`div` is XPath's real division everywhere**, and integer division, which a record `div` over
    two integers means today, becomes `quotient` (part 01).
11. **Types on two axes**: the data type and what Core holds at run time, because finding 56's
    lowering needs both. A Hidden Value's type is a least fixpoint over the document; its bind keeps
    today's rule (part 01 §3, part 03 §5, part 04 decision 13).
12. **The record dialect and form XPath stay two grammars** with the round-trip law
    `parse(print(e)) = e` per grammar, held by fast-check suites over the production parsers and
    printers. Relative paths are admitted in SA and MCP (part 02).
13. **Canonical form XPath is Vellum's own normal form**: a space after every comma and either side
    of every binary operator, a same-precedence right operand parenthesised unless both are the same
    `and` or `or`, numbers in shortest round-trip form. An HQ form-builder save then leaves canonical
    text byte-identical (executed; parts 01 §2.5, 04). A number below 0.000001 is the one exception:
    Vellum's save rewrites it with floating-point error whatever Nova writes, which is what HQ's
    editor does itself.
14. **Session datums are held as what supplies them** (`DatumRef`: `selected-case`, `new-case`,
    `new-child-case`, `worker-record`, `tile-group-parents`). One domain projection,
    `lib/domain/entryDatumSupplies.ts::entryDatumSupplies`, says which refs an entry supplies, and
    the datum id each prints as stays in `lib/commcare/formLinkProjection.ts`; a form link's datum
    name is a `selected-case` (part 05).
15. **Typed instance references**: case queries, data tables in form logic (the bare tag in an XForm,
    `item-list:<tag>` in a suite and a form link), flat locations, selected cases, and an
    inline-search module's results (`results:inline`, excluding the related cases HQ appends, capped
    as HQ caps it in Preview) (part 05).
16. **An untyped case query binds by the catalog.** A custom property read in a query with no
    `@case_type` literal and no `@case_id` of known source binds to the one case type of the
    effective catalog that declares it, and that type is stored; none or several is refused with a
    sentence asking for the `@case_type`. A re-parse of an edited slot takes the slot's current tree
    as its hint, so a bound read keeps its type (parts 01 §1.3, 02 §1.3).
17. **The chosen case is readable in record slots.** A search, a case-list filter or a form's
    display condition evaluated after an earlier menu's case is chosen may read that case's id and
    properties, spelled `chosen-case('<menu name>')` and `chosen-case-property('<menu name>',
    '<property>')` in the record dialect and offered as "The case chosen in <menu>" by the card
    editor, so a search narrowed to a chosen parent is authorable, written in HQ's flag-free
    `parent/@case_id` spelling. HQ writes one case-list filter into every entry the list runs in,
    so a list's filter or search reads a chosen case only where its datum id is the same in each of
    those entries; and because HQ's build renames session variables inside that filter as it aligns
    a child menu's entries with its root, HQ's JSON names the case by its id before that alignment
    (parts 02, 05 §1.3, 06 §3.9, pull request 10).
18. **`many-values` is structural only**: a repeat's answer read from outside the repeat, or a
    several-case module's selected cases, used as one value. A query used as one value is admitted,
    since only its data decides how many rows match, and Core throws at run time on more than one,
    as it does today (part 03 §3.4).
19. **Finding 56 is lowered per operand, inline, in every device position** (form logic, suites and
    CSQL runtime segments, never CSQL text), with literals folded and `now()` not hoisted, and the
    lowering covers `=`, `!=`, `in` and `switch` between two date-and-time operands. An equality with
    an operand that is not a date and time, such as the blank test `x = ''`, stays bare.
    `datetime-coerce` never emits `date()` on a device (part 04 §3).
20. **System dates on a device are days.** `date_opened` and `last_modified` read from `casedb`, and
    `date_opened` read from search results, are days on a device (Core holds a `casedb` system date
    as a `Date`; HQ writes a result's `date_opened` as the UTC day). Ordered against a date and time,
    one is refused unless the other operand is day-aligned, and under `=` or `!=` against any date
    and time it is refused (`day-only-on-device`); against a `date` it is `date-datetime`, as any
    date against a date and time is (part 03 §3.2, part 04 §3.4).
21. **Emitters are total by structured construction.** One wire tree, `WireExpr`, and one serializer
    in five modes (`xform`, `vellum`, `suite`, `hq-json`, `preview`); instance declarations derive
    from the printed tree; CSQL text is a `CsqlNode` tree with its own printer (part 04, part 06).
    A person opening a lowered form in HQ's form builder sees the lowering in its logic field,
    because the shadow must carry the same meaning; step 6 recognises the shape on import.
22. **CSQL equality on a date and time is a closed instant range** (finding 75), and a datetime
    literal names at most a millisecond (part 06 §3.13).
23. **Preview evaluates the device's own XPath** through the same emitter, so every lowering is the
    same code in Preview and on the wire; Preview mirrors Core's day numbers (Kiritimati included)
    and Core's refusal of a preload that does not cast (finding 73); Postgres predicates are
    two-valued over a missing value; a search reads HQ's population, and Preview plays HQ's claim
    where CommCare posts it, on choosing a search action's result and, in a menu that opens on
    Search, once a form is chosen (part 07 §3.5).
24. **Finding 72 is refused where it is decidable**: a literal default on a static choice question is
    one of its options (held as option identity) or refused; a computed default stays admitted.
    The same holds for Nova's own writers: a literal a Hidden Value or a case operation writes into
    a property that a static choice question preloads is one of that question's options or refused
    (`SELECT_PRELOAD_WRITE_NOT_AN_OPTION`).
    **Finding 73's authoring half**: a Hidden Value joins writer agreement, so it cannot write text
    into a property a typed question preloads (part 03 §3.5, §4).
25. **The lane** gains a native family `expression` whose zoned classes run one test JVM per zone, a
    `csql` family, nine targeted documents and an `expression` fuzz generator beside the existing
    sample; fuzz draws are mapped, never drawn again, and `casedata.py` seeds from the effective
    catalog (part 08).
26. **The stack is sized for CI** (below and part 08 §6): three pull requests that move nothing the
    lane observes afresh, then the wire tree as the first that moves most documents' bytes. The
    shape stays one pull request, because a stored shape, its only writers and readers, and the
    corpus that must speak it for the lane to hold cannot land apart.

## Work items

| Item | What it settles | Part |
|---|---|---|
| A. The typed model | The union, identities, types, profiles, the served schemas | 01 |
| B. Authoring and renames | Both grammars, the builder, the guide, the reference index; defect 17 | 02 |
| C. The checker | One checker, the new refusals, findings 72 and 73's authoring half, inference | 03 |
| D. Emission and finding 56 | The wire tree, the lowering, the day rule, canonical bytes | 04 |
| E. Session and instances | `DatumRef`, the typed instance reads, their Preview supplies | 05 |
| F. Typed CSQL | The position model, the constructs, finding 75's HQ half | 06 |
| G. Preview and Postgres | Preview on the device's XPath, Core parity, the compiler over the union | 07 |
| H. Proof | Families, registers, walk stops, corpus, reader runs | 08 |
| I. The cutover and notice | The lift, declarations, the case store, the notice | 09 |

## Proof

Part 08 holds this in full.

- **Finding 56 and finding 75's device half move to `proof/fixed-defects.json`** in pull request 8,
  the lowering: nine entries (finding 56's two of the base and the five pull request 1 adds, finding
  75's two), each still showing on its control. `OPEN_DEFECTS` drops 56.
- **Finding 75's search error on a system date is held, then moved.** With every reader, HQ's
  search for `targeted-datetime-equality`'s "Opened visits" answers 500 on the raw minute-precision
  term; pull request 1 holds it in one walk stop and four live `proof3` and `proof4` entries, and
  pull request 10, CSQL, whose closed instant range HQ parses, moves the four to
  `proof/fixed-defects.json` and the stop to the retained control, which keeps showing both.
  `OPEN_DEFECTS` drops 75 there, and the register test then asserts every live defect is a later
  step's.
- **The six walk stops of findings 72 and 73 leave** in pull request 5, the shape, with no control:
  each refusal is held by its validator's tests beside an accepted neighbour, and production meets
  neither. `proof/walk-stops.json` goes from 29 to 30 in pull request 1 and to 24 here. In the same pull request the Formplayer walk
  stops sending a value a question already holds, as the Web Apps client does, and defect 21's
  knock-on on a list-first form with a location question, which an opened form showed, gets two
  live entries on the new targeted document `targeted-list-first-places` and its control; they stay
  live for step 5, which fixes defect 21.
- **Finding 74's stop stays** (step 4's), and `targeted-datetime-ordering` stays admitted with its
  bytes of source.
- **At the exit** `proof/known-defects.json` holds 282 entries (the base's 282, less finding 56's
  two, plus defect 21's two; 293 after pull request 1) and `proof/fixed-defects.json` 733 (the
  base's 720, finding 56's seven and finding 75's six); `proof/walk-stops.json` holds 24, finding
  75's on its control; `proof/controls/` goes from 105 directories to 108; no spelling rule is added
  or retired.
- **Defect 17 gets a witness, not an entry**: no lane check can observe a stranded reference, so
  `targeted-expression-renames` carries an edit for proof 5 and the rename is held by the gate's
  tests.
- **Where the lane runs.** Every pull request passes the pull request lane in CI without the served
  readers. The first nightly after the merge is the whole lane with every reader over the merged
  stack, and its issue lists every failing group with its rerun line.

## The stack

One `gh stack` chain on the latest `origin/main`, each pull request reviewed and undrafted, merged
together for one deploy. Part 10 gives each pull request's contents, files, register moves,
transform steps, lane cost and checks.

| # | Pull request | Parts |
|---|---|---|
| 1 | Lane mechanics: the zoned harness, the `expression` family's control half, `targeted-datetime-operands` and `targeted-datetime-equality` with controls retained before any fix, eleven live entries and one walk stop, the manifest's property-type reader, the renamespacing check kept in its module's group | 08, 06 |
| 2 | Cutover skeleton: frozen pre-step fixtures, the frozen printer, the emission normalizer, the base emitter | 09 |
| 3 | Projection: the served schemas' pre-substitution, the catalog's three tool inputs removed | 02, 01 |
| 4 | Wire tree for the record family and the scaffolding | 04 |
| 5 | Shape: the union, both grammars, profiles, index and renames, session datum identity, the checker's core, finding 72, finding 73's stop, every corpus source on the union, the walk's model of a held answer, defect 21's two entries on `targeted-list-first-places` | 01, 02, 03, 04, 05, 07, 08 |
| 6 | Checker: the remaining refusals, writer agreement, inference | 03 |
| 7 | Preview: Core parity, two-valued predicates, a search's population and the claim, the entry's session map, the Preview target, protocol 8 | 07, 05, 04 |
| 8 | Lowering: finding 56, its equality half, the day rule; nine register moves | 04, 03, 07, 08 |
| 9 | Instances and session: the new reads with their Preview supplies | 05, 07, 04, 03, 02 |
| 10 | CSQL, with finding 75's HQ half (four register moves, its walk stop to its control) and the chosen case in record slots | 06, 01, 02, 03, 04, 05, 07, 08 |
| 11 | Builder | 02 |
| 12 | Authoring; the billed `npm run test:schema` asked once at this head | 02 |
| 13 | Cutover | 09 |
| 14 | Contracts and public docs; the maintenance image is built from this head | 10 |
| 15 | Removal of the cutover tooling and of this plan | 09, 10 |

**CI.** A stacked pull request never reads its base's records (`proof/ci/store-keys.mjs`), and a push
to one restacks every pull request above it. Pull requests 1 to 3 run the lane's 10.2-minute row;
from pull request 4, which moves most documents' bytes, each runs the 12.9-minute row. A push to
pull request 1 therefore starts fifteen lane runs, about 186 shard-jobs against twenty concurrent
runners, roughly two hours. So the shape is settled on its own branch before the stack is cut, a
fix-up goes to the pull request it belongs in, and a session's pushes are batched into one (part
08 §6, part 10 "House rules").

## The cutover

One direct maintenance cutover (`docs/architecture/contracts.md`), planned in full in part 09. It
is lean: it reads no HQ state, decrypts no key and needs no KMS grant.

- **A fold horizon.** Every expression slot's stored shape changes, so pre-horizon history cannot
  replay. Each app gets a baseline at the final shape, marker
  `fold-baseline:hq-round-trip-expressions`, admitted by new DDL that copies step 2's admit
  functions with a fifth identity pair.
- **The lift is the production parser.** Each stored form expression is printed with a frozen copy
  of today's printer and parsed with step 3's production parser against the target document, so
  there is no second lifting dialect and any parse refusal is a blocker. Record expressions map
  structurally. Seven ordered steps: the catalog rules, form-link datum names, record expressions,
  the form-logic lift, declarations of the properties expressions read, the repeat first-row lift,
  and a round-trip guard.
- **Declarations** take the least type their reads admit, and the case store converges through the
  existing drift writer after the deploy and before ingress reopens.
- **One Job, one fleet transaction**, dry run then execute against the plan digest, on the
  historical-repair Job made for the window and deleted after it. The two `designSessions.ts`
  helpers #767 made private are exported again for the cutover's lifetime.
- **A notice on every affected app** through `lib/notices`, with a new cutover id, its lead and one
  reason for each change a person sees (part 09 §12 is the registry): the catalog rules removed,
  expressions that now follow choices, expressions respelled, case properties declared because an
  expression reads them, a repeat read that now takes the first row, the worker's-day search, the
  date-and-time equality search, date-and-time comparisons that now compare moments, a property
  type now known, and, per deployment, the expressions the next publish sends. A change that prints
  the same text (a relative path or a case query held as identity) gets no line.
- **A blocker** is any stored expression the production parser or the new checker refuses (an
  untyped query no single case type explains, a writer the new rules refuse, a cycle); the dry run
  lists each, and the author resolves it in the app before the window (part 09 §11).
- **People lose unsaved private work**, open assistant work and unsaved builder edits; the window is
  announced.

## Contracts

Part 10 gives each sentence as it reads today and its replacement. In brief:

- Root `CLAUDE.md`, mental model 4: every reference in an expression is identity; text is a
  projection in two grammars.
- `lib/domain/CLAUDE.md`, `lib/doc/CLAUDE.md`, `lib/commcare/CLAUDE.md`,
  `lib/commcare/xpath/CLAUDE.md`, `lib/preview/CLAUDE.md`, `lib/case-store/CLAUDE.md` and
  `lib/codemirror/CLAUDE.md` are rewritten for the union, the one checker, the wire tree and Preview
  on the device's XPath; `lib/domain/predicate/CLAUDE.md` leaves with its package and
  `lib/domain/expression/CLAUDE.md` is new. Each sentence is rewritten in the pull request whose
  behavior makes it false.
- `lib/db/CLAUDE.md`: five fold-baseline identities.
- `docs/architecture/complex-apps.md`: the binding CommCare facts step 3 relies on (instant text,
  system dates as days, HQ's datetime rewrite, the search population and claim).
- The public docs on conditions, calculations, case-list filters and search, in Nova's voice.
- `harness-findings.md`: findings 56, 72, 73 fixed, finding 75 added and fixed; `proof/README.md`
  and `proof/CLAUDE.md` for the new families and documents.
- `../nova-plugin` (read for this plan): no sentence of its skills becomes false, so it needs no
  release; pull request 12 sweeps it again against the guide it ships.

## Exit

- No Nova expression slot stores a reference as text, and every rename, move and removal reaches
  every reference by identity.
- A date and time orders and compares by instant on every device, in every zone, and in HQ's search;
  the register holds no entry for findings 56 or 75, and every fixed entry shows on its control.
- Every walk reaches its end or one of the 24 stops `proof/walk-stops.json` holds by name; none is
  finding 72's or 73's, and finding 75's is held on its control alone.
- Proofs 1 to 5 pass on every Nova export, and every control directory is named by a register.
- Every existing app is valid under the new schema and validator, and carries its notice.
- The first nightly over `main` after the deploy, the whole lane with every reader over the merged
  stack, holds.
