# Step 3, part 08: Proving step 3 on the lane

Part of [step 3's plan](../3-expressions.md), which holds the baseline, the decisions, the stack and
the exit. This part holds how the proof lane proves step 3: the native family that runs finding
56's lowering in device time zones and the one-JVM-per-zone mechanism it needs, the register and
walk-stop moves of findings 56, 72 and 73, what every corpus source changes in the pull request
that changes the stored shape, the typed expression fuzz generator, the targeted documents step 3
adds, what proofs 1 to 5 and the manifest check say about each change, what each pull request
costs in CI, the order that keeps the expensive runs few, the reader runs, and pull request 1, the
lane mechanics.

Citations are `path::symbol` for Nova at `main` `5cf6e327` and `file::symbol` for CommCare at the
pins `proof/pins.json` names: commcare-core `8e9ba8d908e9` (paths under `src/main/java`),
commcare-hq `d6c6e16d8ae1`, formplayer `24383ac71bfb`, commcare-android `7a5584475580`,
commcare-connect `046c7fd78081`, Vellum `01215f251c57`. A CommCare fact marked "(read)" was read at
the pin for this part. Stack references use the fifteen pull requests by number and name; part 10
holds the stack in full.

Where production holds a shape this part proves, it says so in words, and no production count
enters this part: the cutover's dry run counts each at the window (§3.6, part 09). The runs this
part relies on are named in "Executed during planning": scratch branches cut from `main` and run on
GitHub's runners (R1 to R4), host emissions of the whole corpus, and read-only probes. R2's and R3
and R4's served verdicts are in, and so is R1's first shard (§6.4); R1's second shard is
outstanding, and each place that depends on it says so in one marked sentence.

## Decisions in brief

1. **A new native family, `expression`, runs finding 56's lowering in seven zone setups.** Its
   producer (`proof/native/producers/emit-expression-evidence.ts`) writes one table of operand
   pairs (`lib/commcare/__tests__/instantOrderingTable.ts`) with each pair's comparison as Nova's
   production on-device emitter prints it. Its Core class, `InstantOrderingRuntimeTest`, runs once
   in each of four device zones (`UTC`, `America/New_York`, `Asia/Kolkata`, `Pacific/Kiritimati`)
   and three Formplayer-like setups (a UTC JVM with a browser provider in New York, in Kolkata, and
   New York as an offset alone), each in its own test JVM. It builds no app, so it joins no corpus.
2. **Zoned classes run in a test JVM of their own, never in the suite's.** The init script
   registers one Gradle `Test` task per zone with `systemProperty('user.timezone', <zone>)`, the
   mechanism the planning execution proved (`GRADLE_OPTS` does not reach the test JVM);
   `families.py` gains `ZONES` and `ZONED_CLASSES`; `test_core_runtime.py` reports each zoned class
   once per zone and fails on a zoned class that ran in the suite's JVM or missed a zone.
3. **Each of finding 56's seven requirements has a named test** (§2.3): five at the wire tree's
   and the checker's own boundaries (`lib/commcare/xpath/wire/__tests__/instant.test.ts`, part 04
   §6; part 03's `typeChecker.test.ts`), the zones and the malformed text in the native family, and
   the CSQL half in part 06's `csql` family.
4. **Pull request 1, the lane mechanics, is the stack's bottom pull request** (one stack, merged
   together with one deploy, decided with the person, 2026-10-17), and changes nothing Nova emits:
   the zoned harness, the `expression` family's pre-fix half (Core's bare comparisons in every
   zone, the control the lowered half is measured against), a reader of a case property's type for
   `proof/checks/manifest_value_classes.py::_time_kind`, and two new targeted documents, each with a
   control retained before any fix: `targeted-datetime-operands`, whose five pre-fix classes (three
   `intent`, two `manifest`) are registered under finding 56, and part 06's
   `targeted-datetime-equality`, whose device half is registered under finding 75 in two entries
   (`OPEN_DEFECTS` gains `75: 3`). Every entry is the one the executed run held (§7). It adds no
   walk stop. It costs the 10.2-minute row. The cutover's pre-step half is not here: it is pull
   request 2, the cutover skeleton (part 09).
5. **Finding 56's seven entries and finding 75's two move to `fixed-defects.json` in pull request
   8, the lowering**: the two of `targeted-datetime-ordering`, the five of
   `targeted-datetime-operands` and the two of `targeted-datetime-equality`, on their controls;
   `OPEN_DEFECTS` drops 56 and 75, and `test_every_live_defect_is_a_later_steps` asserts
   `step > 3`. Finding 75's HQ half is part 06's `csql` family scenario `datetime-equality`, in pull
   request 10, CSQL.
6. **`targeted-datetime-ordering` stays admitted and unchanged.** Settled by reading (§3.2): its
   hidden values are `datetime` by inference from `#visit/seen` and `#visit/due` and held as text
   under their `xsd:string` bind (binds keep today's rule, part 03 §5.2), its two orderings are
   datetime against datetime, which the form rule set admits and lowers, and its survey form, which
   carries finding 74's stop, keeps its bytes of source. Finding 74's stop keeps showing.
7. **The six walk stops of findings 72 and 73 are removed with no control**, both in pull request
   5, the shape, which takes each off its document: finding 72's five with
   `SELECT_DEFAULT_NOT_AN_OPTION` and the generator's mapped default, finding 73's one with
   `casedata.py` reading the effective catalog; `walk-stops.json` goes from 29 entries to 23. Each
   refusal is held by its validator's tests, refusal beside accepted neighbour. Production meets
   neither: it holds no literal choice default outside its options and no case row a typed preload
   fails to cast. The removal is proved by the host emission, those tests and the served readers
   of run 39064336028 (§3.3, §6.4): no opened form reaches a reader's own end, and what the run
   showed past them is two things pull request 5 carries, a fix to the Formplayer walk's model of
   an answer a question already holds, and two live entries under defect 21 with the targeted
   document `targeted-list-first-places` that shows them.
8. **Every source that builds a document speaks the union in pull request 5, the shape.** Fuzz draws
   are mapped after the draw and never drawn again, so the 24 fuzz ids and every other draw stay.
9. **A new fuzz generator, `expression`, draws typed expressions over a drawn document** (eight
   documents, `fuzz-expression-20260930-0` to `-7`), appended as its own generator so the existing
   sample is untouched. It draws only what the gate admits.
10. **`proof/observe/casedata.py` reads the stored union wherever it is stored and the effective
    catalog,** which `document.json` carries as `catalog` from pull request 5, in the
    `materializableCaseTypes` flavor: the effective types without the implicit standard entries, as
    Nova's own sample surfaces read them (`lib/domain/CLAUDE.md`, "Property types are derived
    facts"). Executed during planning (R4's host diff): at `main` it changes the seeded case
    databases of 15 of 371 documents, finding 73's among them; the flavor with the standard entries
    would change 252, every one by seeding an `external_id` no Nova writer put there (§4.4).
11. **Defect 17 gets a witness with its fix, not a register entry.** No lane check can observe a
    stranded reference (an expectation reads D's exports only, and proof 5 sees no digest a stale
    text leaves unchanged); `targeted-expression-renames` carries an edit so proof 5 holds the
    reference index complete over every new reader, and the rename itself is held by part 02's
    gate tests.
12. **Step 3 adds nine targeted documents** (§4.5), among them part 06's
    `targeted-datetime-equality` for finding 75 and `targeted-list-first-places` for defect 21's
    entries of §3.3. Each has explicit identities and values fixed by
    hand, and each lands in the pull request whose feature it shows: `targeted-session-reads` in
    pull request 5, the shape, with session datum identity and the Core session-read scenarios of
    `FormLinkRuntimeTest`, `NestedMenuRuntimeTest` and `TileGroupingRuntimeTest` that read today's
    datums (§2.6), so datum reads have lane evidence from the pull request that changes them; pull
    request 9 adds the document's batch form, whose `selected_cases` read lands with the other new
    instance reads.
13. **Served readers run on GitHub's runners only, never on the person's machine.** Planning's
    first dispatches of R1 to R4 with every reader (runs 39058712962, 39058666752, 39058667355) each
    died in the Android reader runtime job, which has failed main's own nightly the same way since
    2026-10-14 (issue 768). The runs without readers held (R1 run 39061011794, but for the manifest
    classes §7 registers; R2 run 39061476968, clean), and R3 and R4 have the host emission. Planning
    wrote the fix for issue 768 (commit `ee852ae9`), and the second dispatches put it beneath each
    scratch change (R1 run 39064331941, R2 run 39064333759, R3 and R4 run 39064336028): the Android
    runtime job passes in all three. The fix is #771, stacked on this plan's pull request. R2's
    second dispatch held with every reader. R3 and R4's showed no reader's own end past an opened
    form, and two things pull request 5 carries: the walk's model of an answer a question already
    holds, and two defect 21 entries (§3.3). R1's first shard showed every served reader
    reproducing finding 56's literal case-list half and nothing unregistered but the manifest
    classes §7 registers (§6.4). **Outstanding:** R1's second shard, which lost its hosted runner,
    and with it `targeted-datetime-equality`'s served verdict. R5 runs at pull request 5's branch
    over the eight `fuzz-expression-20260930-*` documents, `targeted-expression-renames`,
    `targeted-session-reads` and `targeted-list-first-places`, and over the five documents of the
    walk model's gap after its fix (§6.4). No reader run is required before the merge; the first night after it
    reads every document with every reader, which needs #771 on `main`.
14. **The order is the stack's fifteen pull requests** (part 10 holds the table). Pull requests 1
    to 3 (lane mechanics, cutover skeleton, projection) run the 10.2-minute row; pull request 4, the
    wire tree, moves most documents' bytes, so it and every pull request above it run the
    12.9-minute row on every push, because a stacked pull request never reads its base's records.
    A push to pull request 1 starts fifteen lane runs, 186 shard-jobs against twenty concurrent
    runners (§6.2).

---

## 1. The lane at step 3's base

At `5cf6e327`:

| Thing | At the base | What step 3 owns |
|---|---|---|
| `proof/known-defects.json` | 282 live entries | finding 56's two: `d56-datetime-ordering-evaluate-answers`, `d56-datetime-ordering-evaluate-case-text`, both intent, both on document and control `targeted-datetime-ordering`; the seven pull request 1 adds, finding 56's five on `targeted-datetime-operands` (three `intent`, two `manifest`) and finding 75's two on `targeted-datetime-equality` (§7); and the two pull request 5 adds under defect 21, on `targeted-list-first-places`, which stay live for step 5 (§3.3) |
| `proof/fixed-defects.json` | 720 entries on 85 controls | none |
| `proof/controls/` | 105 directories | three: `targeted-datetime-operands` and `targeted-datetime-equality`, retained in pull request 1, and `targeted-list-first-places`, retained in pull request 5 |
| `proof/walk-stops.json` | 29 entries | six: finding 72's five (`fuzz-suite-20260930-5`, `fuzz-suite-20260930-8`, `fuzz-xform-20260930-0`, `fuzz-xform-20260930-1`, `fuzz-xform-20260930-7`, all `notification:value-could-not-be-loaded-into-question`) and finding 73's one (`expander-output-references-in-labels-lowers-several-typed-e72b42c4-0`, `notification:invalid-data-type-in-setvalue-event-targetting`), all removed in pull request 5, the shape (29 to 23); none added (§3.2) |
| `proof/checks/registers.py::OPEN_DEFECTS` | `{20: 4, 21: 5, 23: 5, 24: 5, 25: 5, 26: 5, 27: 5, 28: 5, 30: 5, 56: 3}` | `56: 3`, and `75: 3`, which pull request 1 adds |
| Corpus | 371 documents | every one, because the stored shape changes; plus nine targeted documents (§4.5) and eight fuzz documents (§4.3) |

Three neighbouring stops are not step 3's and stay: `targeted-datetime-ordering`'s
`submit-refused:validation-error` (finding 74, step 4), `fuzz-suite-20260930-8`'s `search-refused`,
and `fuzz-xform-20260930-4`'s `submit-refused:validation-error` (its weight question's
`validate` is `false()`, which from step 3 parses to `match-none` and stays admitted).

What the corpus exercises of form logic today (executed during planning, a shape scan over the 371
documents emitted at `main`): relative reads only as `current()`-rooted paths (18 in 11
documents), `instance('casedb')` queries in one non-fuzz document, no `..` read, no ordering
between typed operands outside `targeted-datetime-ordering`, and no fuzz expression with a
reference at all (every fuzz slot is `opaqueXPathExpression` over a constant pool,
`lib/commcare/__tests__/xformDocArbitrary.ts`). The typed model's checks would be nearly vacuous
over the corpus without §4.3 and §4.5.

Production holds every one of these shapes, and far more of each: relative reads in many apps
(most of them `.` in a `validate`, with `..` reads and query-repeat row reads among them), `casedb`
queries in some apps (some naming no `@case_type`), absolute `/data` reads, session reads, and a
few datetime orderings. The lane never reads a production document, so §4.3 draws and §4.5 fixes
by hand every shape production holds, each at least once.

---

## 2. Native proofs

### 2.1 One test JVM per zone

**Why a JVM per zone.** Core reads two zones. `DateUtils.timezone()` and the offset come from the
installed `TimezoneProvider` (`org/javarosa/core/model/utils/DateUtils.java::setTimezoneProvider`,
`::timezone`, read), which Formplayer sets per request from the browser
(`formplayer services/BrowserValuesProvider.java::setTimezoneOffset`, `::getTimezone`, installed by
`aspects/SetBrowserValuesAspect.java` through `DateUtils.setTimezoneProvider`, read). But
`DateUtils.fractionalDaysSinceEpoch` corrects by `a.getTimezoneOffset() - EPOCH_DATE.getTimezoneOffset()`
(read), the JVM default zone through `java.util.Date`, and `EPOCH_DATE = getDate(1970, 1, 1)` is a
`static final` built at class load in the default zone (read). A provider swap, as
`proof/native/core/CaseOperationRuntimeTest.java::clockZone` does today, cannot move either, so a
proof of a lowering that must not depend on the device zone runs each device zone in its own JVM.

**Executed during planning** (the native lowering run, "Executed during planning"): an init script
registering one `Test` task per run proved the mechanism over Core's own Gradle test build at the
pin, offline in the pinned image. `test.systemProperty('user.timezone', zone)` set the test JVM's
zone in every run; `test.environment('TZ', zone)` and `JAVA_TOOL_OPTIONS` did too;
`-Duser.timezone` in `GRADLE_OPTS` reached only Gradle's client, and the test JVM ran in the
image's `Etc/UTC`. Ten test JVMs ran in 30 to 39 seconds after one test-source compile; each class
run took 3.4 to 3.7 seconds by its JUnit report, including the probe's 1,000-case cost loops.

**From step 3** (the mechanism and the first zoned class in pull request 1, the lane mechanics, §7):

- `proof/native/families.py` gains

  ```python
  @dataclass(frozen=True)
  class Zone:
      label: str                 # the Gradle task, the JUnit directory and the test id
      jvm: str                   # the test JVM's user.timezone
      provider: str | None = None   # a TimezoneProvider in this zone, as Formplayer installs one
      offset_only: bool = False     # the provider gives an offset and no zone

  ZONES = (
      Zone("utc", "UTC"), Zone("new-york", "America/New_York"),
      Zone("kolkata", "Asia/Kolkata"), Zone("kiritimati", "Pacific/Kiritimati"),
      Zone("formplayer-new-york", "UTC", "America/New_York"),
      Zone("formplayer-kolkata", "UTC", "Asia/Kolkata"),
      Zone("formplayer-new-york-offset", "UTC", "America/New_York", offset_only=True),
  )
  DEVICE_ZONES = ZONES[:4]   # utc, new-york, kolkata, kiritimati

  # Core classes that run once per zone, each zone in a test JVM of its own, never in the suite's.
  ZONED_CLASSES = {
      "InstantOrderingRuntimeTest": ZONES,                     # pull request 1, the lane mechanics
      "CoreDateParityRuntimeTest": DEVICE_ZONES,               # pull request 7, Preview (part 07 §2.4)
      "CsqlCompositionRuntimeTest": (ZONES[0], ZONES[3], ZONES[1]),  # pull request 10, CSQL (§2.5)
  }
  ```

  The dict above is step 3's exit; each pull request adds its own row. Part 07's
  `CoreDateParityRuntimeTest` (part 07 §2.4) evaluates the Preview date fixture's rows
  (`lib/preview/xpath/__tests__/fixtures/coreDateParity.ts`) with Core and runs in the four device
  zones only, since Formplayer's day numbers are step 4's (part 07 §2.3);
  `CORE_CLASSES["CoreDateParityRuntimeTest"] = "expression"`, and the family's producer writes the
  fixture's rows for it.

  `CORE_CLASSES` keeps every class, zoned ones included, with the family it reads, so
  `NativeSession.upstream_failures` names a zoned class's producer failure as it does any other.
  The three Formplayer setups are what `BrowserValuesProvider` can hold: a browser zone Java knows,
  and an offset alone when `TimeZone.getAvailableIDs()` lacks the browser's id. A server JVM in a
  zone other than UTC is the device-zone runs' case, since the lowering reads no JVM zone.
- `proof/native/core/native-proof.init.gradle` takes `-PnovaProofZones=<label>|<jvm>|<provider>|<offsetOnly>|<Class>+<Class>;…`.
  The `test` task gains `filter.excludeTestsMatching('nova.compatibility.<Class>')` for every zoned
  class; each zone registers `novaZone_<label>`, a `Test` task over the same test classes and
  classpath, configured as `test` is (heap, collector, `ignoreFailures`, never up to date), with
  `includeTestsMatching` for its classes, `systemProperty('user.timezone', jvm)`,
  `nova.proof.zone.label`, `nova.proof.zone.jvm`, `nova.proof.zone.provider` and
  `nova.proof.zone.offsetOnly`, and its JUnit XML under `<reports>/zones/<label>/`; `novaZones`
  depends on all of them. The header comment says why a zoned class never shares the suite's JVM.
- `proof/native/core_suite.py::core_tests_command(selection, *, native_dir, reports, zones=())`
  appends `-PnovaProofZones=…` and the `novaZones` task when `zones` is given, so one Gradle
  invocation compiles once and runs the suite's JVM and every zone's.
  `run_core_tests` reads `zones/<label>/TEST-*.xml` into `CoreRun.zoned: dict[tuple[str, str], CoreClass]`
  keyed by `(class, label)`. `NativeSession.core()` passes `families.ZONES` with `ZONED_CLASSES` for
  the `"*"` selection; `media_certificate` passes none.
- `proof/native/test_core_runtime.py`: `test_core_runs_the_proof_class` is parametrized over the
  unzoned classes and over `(class, zone)` pairs (ids `InstantOrderingRuntimeTest[new-york]`), each
  reading its own result. `test_gradle_runs_exactly_the_listed_classes` asserts, beside today's two
  sets: no zoned class reported from the suite's JVM (the exclusion held); each zoned class reported
  from every zone `ZONED_CLASSES` gives it and from no other; and no zone directory a run wrote that
  `ZONES` does not name. Its docstring says "once per zone for a zoned class".
- Every zoned class's first assertion is its own zone: `TimeZone.getDefault().getID()` equals
  `nova.proof.zone.jvm` and `DateUtils.timezone()` is the provider's zone (or `null` for
  offset-only and for no provider). A mechanism that silently stops applying (the `GRADLE_OPTS`
  case) fails there by name, before any value is read.
- `proof/README.md`, "Native proofs" ("How a family runs", point 4, and "What each run leaves":
  `core/suite/junit/zones/<label>/`) and the family's own section.

### 2.2 The `expression` family

| Piece | Path | Holds |
|---|---|---|
| Table | `lib/commcare/__tests__/instantOrderingTable.ts` (new) | The one statement of meaning: operand rows (an instant, how it is held: a typed `DateTimeData` answer, text written by Core's own formatter in a writer zone, text in a fixed spelling, a typed `DateData` date, `now()` under a fixed clock, malformed text), pair rows (two operands, an operator), and the DST pairs. No expected value: the Java class computes each from `java.time`. |
| Producer | `proof/native/producers/emit-expression-evidence.ts` (new) | `native/expression/orderings.json`: every pair with each operand's node name and value, and, from pull request 8, the lowering, on, the comparison exactly as `serializeWire(toWire(…), { target: "xform" })` prints it (`lib/commcare/xpath/wire/`, the lowering `instant.ts`, part 04 §3), never hand-written XPath, over a typing context built with `lib/__tests__/docHelpers.ts::buildDoc` (a datetime question, a Hidden Value copying a datetime case property, a date question per operand class), never compiled into an app. |
| Core class | `proof/native/core/InstantOrderingRuntimeTest.java` (new, zoned) | Built as the planning probe class of the native lowering run was, without its cost loops. Two halves, below. |
| `families.py` | `_script("expression", "emit-expression-evidence.ts")`; `CORE_CLASSES["InstantOrderingRuntimeTest"] = "expression"` (pull request 1) and `CORE_CLASSES["CoreDateParityRuntimeTest"] = "expression"` (pull request 7, part 07 §2.4); `ZONED_CLASSES` as §2.1 | |
| `producers.ts` | unchanged | The family builds no app, so its rows join no corpus, as `predicate`'s do not (`proof/corpus/producers.ts` header). |

The class builds a `FormInstance` per pair (typed nodes as `DateTimeData` / `DateData`, text nodes as
`StringData`, as the probe does), and evaluates with `XPathParseTool.parseXPath` and
`FunctionUtils.unpack`.

- **The control half** (pull request 1, the lane mechanics): each pair's bare comparison, asserting
  Core's documented behaviour in the run's zone, computed independently: a text operand orders
  false both ways (`FunctionUtils.toNumeric`, NaN); two typed operands order as their calendar days
  in the reader's zone (`java.time` `LocalDate` of each instant there); and
  `double(coalesce(x, ''))` of the DST fall-back pair orders by local wall time, so it is misordered
  in `new-york` and right in the others (executed: the `double(coalesce) fb1 < fb2` row is `false`
  only in the New York JVM); and a bare `=` between two text spellings of one instant is false,
  because Core compares two strings by text (`org/javarosa/xpath/expr/XPathEqExpr.java::testEquality`,
  read), which is finding 75's device half. This half is the family's retained control: it shows
  on every run that the zones are real and that the bare spelling is what the lowering replaces.
- **The lowered half** (pull request 8, the lowering): each pair's lowered comparison from
  `orderings.json` gives the instant order, in every zone, for `<`, `<=`, `>`, `>=`, `=` and `!=`
  (equality between two `datetime` operands is instant equality, exact on the integer microseconds
  both sides lower to, since Core's `1.0e-12` tolerance in `XPathEqExpr.java::testEquality` is far
  below one, part 04 §3.3; `in` and `switch` lower to the same equality and are held at the wire tree's boundary,
  §2.3).

Rows, each run in all seven setups:

| Group | Rows |
|---|---|
| Spellings | one instant in the 13 offset spellings the probe proved (`Z` with 0, 3 and 6 fraction digits; `+05`, `+05:30`, `+05:45`, `-05:00`, `-05`, `-03:30`, `+14`, `-11:00`; naive with and without a fraction), every pair of spellings equal, and each against the same spellings an hour later ordered; HQ's own spelling of a datetime it received, `…T04:30:00.000000Z`, which every case HQ processes holds (`corehq/form_processor/utils/xform.py::adjust_datetimes`, read and executed, part 06 §3.13) |
| Writers | text written by Core's own formatter (`DateTimeData.uncast`) under a writer provider in `Asia/Kathmandu` and `America/Los_Angeles`, zones no reader setup uses, read in each setup: requirement 7's "value written in a third" |
| Typed against text | a typed answer against each spelling of the same instant: equal, and ordered against an hour later |
| Microseconds | 1,500 same-instant pairs and 1,500 pairs one microsecond apart (the probe's sweep) |
| DST | America/New_York fall-back, `2026-11-01T01:30-04:00` and `01:30-05:00`, typed and as text; spring-forward, `2026-03-08T01:59-05:00` and `03:00-04:00` |
| Dates | a date against a date (bare, both typed and text), and a date coerced to a datetime against a datetime of the same UTC day, entering as the UTC-midnight day number |
| `now()` | a typed answer and a text operand against `now()` under the run's clock, bounded by the instants before and after |
| Malformed | the probe's 28 malformed texts against a typed answer and each other: no evaluation throws, and every ordering with one is false |

### 2.3 Finding 56's seven requirements, each to its test

| # | Requirement (outline) | Test | Boundary |
|---|---|---|---|
| 1 | Chosen per operand from its type, never by wrapping the whole comparison | `lib/commcare/xpath/wire/__tests__/instant.test.ts` (new, part 04 §6, owned with the lowering): for each `(data, held)` pair of part 01 §3.1 the wire tree's operand nodes, read structurally from the tree (never from text), are the operand's own lowering (part 04 §3.2's table), a comparison over two non-datetime operands is bare, an equality between two `datetime` operands is lowered and one with a non-`datetime` side (`x = ''` above all) is bare, and every fold agrees with `Date.UTC` for each of the native run's 13 spellings. Native: every pair of §2.2 in every setup. | pure; Core |
| 2 | `date()` is never applied to `now()` or a typed answer | the same file: no `date` call over a `now` or a typed-answer operand in any pair's wire tree. Native: typed pairs an hour and a millisecond apart on one day order right in every zone, which `date()` would order by day. | pure; Core |
| 3 | A date against a date stays bare | the same file: the wire tree of a date against a date is the stored comparison. Native: the Dates rows. | pure; Core |
| 4 | A date against a datetime is refused without an explicit coercion, and a coerced date enters as the UTC-midnight day number | part 03's `lib/domain/expression/__tests__/typeChecker.test.ts` (`#form/d = now()` refused, `date(now()) = #form/d` accepted). Native: the coerced row in every zone. Preview's agreement is part 07's test over the same table; CSQL's is part 06's `csql` family (a date-only bound on a datetime property compares the UTC day, part 06 §3.13). | pure; Core; HQ |
| 5 | A lowering that reads text does not throw on malformed text | Native: the Malformed rows, no throw in any setup (executed: `date('nope')` throws and the lowering does not). | Core |
| 6 | No on-device wrapper leaks into a CSQL segment | part 04's `instant.test.ts` (no lowering inside a CSQL text position) and part 06's `lib/commcare/csql/__tests__/positions.test.ts`: a datetime ordering in a `query`, `anchor` or `server-value` position prints the bare CSQL comparison and in a `runtime` segment takes the on-device lowering; `csql@A` (`proof/checks/intent.py::search_compiles`) compiles `targeted-csql-composition`'s queries; part 06's `csql` family runs HQ's search over them. | pure; HQ |
| 7 | At least two device zones, with a value written in a third | Native: four device zones and three Formplayer setups, with Core-written values from two writer zones and fixed spellings in eleven offsets. | Core |

The lane's documents run every runtime in UTC only (`proof/core/client.py::JVM_OPTIONS`,
`-Duser.timezone=UTC`; `proof/formplayer/webapps.py::TIMEZONE`; the container's `TZ=UTC`), so no
targeted document can meet requirement 7; what the lane adds is the cross-path half (§3.1).

### 2.4 The `xpath` and `predicate` families under the union

Pull request 4, the wire tree, deletes the on-device emitters (`lib/commcare/expression/onDeviceEmitter.ts`
and the on-device halves of `lib/commcare/predicate/*`, part 04 §2.6), so it re-points every lane
file that reads them, in the same pull request:

- `proof/native/producers/emit-predicate-evidence.ts`: its `emitCaseListFilter(predicate, "casedb", …)`
  call becomes `serializeWire(toWire(…), { target: "suite" })` over the same programs;
- `proof/native/producers/emit-arithmetic-evidence.ts`: its `emitOnDeviceExpression` call for the
  division-by-zero probes becomes `serializeWire(toWire(…), { target: "xform" })`;
- `proof/native/producers/emit-lookup-evidence.ts`: its `sourceHashes` provenance list, which reads
  each file with `readFileSync`, names `lib/commcare/xpath/wire/fromExpression.ts`,
  `serialize.ts` and `instances.ts` in place of `expression/onDeviceEmitter.ts` and
  `predicate/termEmitter.ts`, which would otherwise throw `ENOENT`;
- `proof/corpus/footprint.ts`: its `collectPredicateInstances` / `collectExpressionInstances`
  imports become the serializer's instance set (`lib/commcare/xpath/wire/instances.ts`, part 04
  §2.6).

Each family keeps its assertions over the new print, so `PredicateRuntimeTest` and
`ArithmeticRuntimeTest` passing unchanged is the proof the wire tree kept the printed meaning, and
`proof/native/test_lookup_workbook.py` records the new provenance in its evidence. Both families below then move in pull request 5, the shape:

- `predicate`: `emit-predicate-evidence.ts` builds its 52 programs with the
  union's builders (`lib/domain/expression/builders.ts`) in place of the Predicate constructors.
  `PredicateRuntimeTest` keeps its assertions; that they pass unchanged is the proof the record
  arms kept their meaning.
- `xpath`: `lib/commcare/xpath/__tests__/nativeXPathCorpus.ts` gains one case per row of part 01
  §2.1's mapping (the 16 names on arms and the 60 on `call`), each printed canonically by the
  production printer; `XPathCarrierCompatibilityTest::everyClaimedNativeFunctionUsesCoresBuiltInDispatch`
  and `::authoredArityAdmissionMatchesTheNativeParser` read them, so each canonical print parses in
  Core to the function its row names with Core's arity. The producer's `lowerXPathForJavaRosa`
  call becomes `toWire`'s, which
  `XPathCarrierCompatibilityTest::executesCurrentProductionLoweringsAndClassifiesActualNativePaths`
  then reads (part 04 §6), since part 04 removes `xpath/javaRosaLowering.ts`.
  The native family keeps its name and its class. What leaves in pull request 5 is the repository's
  XPath carrier compatibility scan and migrate scripts (`scripts/scan-xpath-carrier-compatibility.ts`,
  `scripts/migrate-xpath-carrier-compatibility.ts` and their libraries and tests), which read stored
  text through `carriers.ts` and `analyzeXPathCompatibility`; what they verified is from there
  unrepresentable or a commit-gate finding (part 10, pull request 5). No lane file names them.

### 2.5 The `csql` family (part 06)

Part 06 §8 adds it (`csqlCompositionFixture.ts`, `emit-csql-evidence.ts`,
`CsqlCompositionRuntimeTest`, `proof/native/test_csql_payload.py`). Its Core class is zoned through
§2.1: `ZONED_CLASSES["CsqlCompositionRuntimeTest"] = (utc, kiritimati, new-york)`, which covers
part 06's "two JVM zones" for CSQL `today()` and runtime choice with a zone whose day differs from
UTC's most of the day and one with DST. Its fixture documents are producer documents and join the
corpus through `producers.ts`, so the rule of §2.6 applies. Its scenario `datetime-equality`
(part 06 §3.13) holds finding 75's HQ half: cases saved through HQ's receiver, so every stored
datetime is HQ's own spelling, and HQ's search over the closed instant range returns the fixture's
ids; it lands with the CSQL emitter change in pull request 10, CSQL, fails on today's emitter and
passes on the fix. No lane check reads HQ's search results (`csql@A`,
`proof/checks/intent.py::search_compiles`, is a refusal check), so the family is that half's only
witness.

### 2.6 Part 05's reads in existing families

Part 05 §5 extends six Core classes, in two pull requests:

- **Pull request 5, the shape**, with session datum identity: the session-read scenarios that read
  today's datums. `FormLinkRuntimeTest` and `NestedMenuRuntimeTest` read each `DatumRef` kind
  through Core's session and assert the value read equals the case the case block creates, on the
  local archive and HQ's regenerated form; `TileGroupingRuntimeTest` reads the companion datum.
  Their producers are `emit-form-link-evidence.ts`, `emit-nested-menu-evidence.ts` and
  `emit-tile-evidence.ts`.
- **Pull request 9, instances and session**, with the new instance reads: `LookupRuntimeTest` (a
  form-logic `table-rows` read and a link condition reading `item-list:<tag>`),
  `LocationOwnerRuntimeTest` (a form-logic `locations` read and a link condition reading a place's
  name) and `SearchRuntimeTest.formReadsTheResultsItsSearchReturned` (part 05 §2.8).

Each new scenario is a producer document, and `producers.ts::produced()`
adds it to the corpus, where the fixed floor's edit batches are balanced across producer documents
(`proof/corpus/editBatches.ts::editBatchCorpus`), so an added scenario can change another fixed
document's edit and with it entries that name that document's B-edit. Decided:

- A new scenario is appended after its fixture's last scenario, with every entity it adds named
  (`buildDoc` mints unnamed identities from one counter per process; step 2 measured 201 documents'
  bytes moved by one unnamed addition, 30 when named).
- Its pull request (5 or 9) runs the emission at base and head with no Docker and diffs every fixed
  document's `edit/batch.json`. If any other document's batch moved, the scenario becomes a
  targeted document instead (a targeted document joins no balanced assignment), and the Core class
  reads that document's archive through the targeted corpus.

### 2.7 Cost

`proof/native` is 15.9 box-seconds in the `no-readers` profile (`proof/timings.json`). The seven
zone JVMs add their class runs: measured at 3.4 to 3.7 seconds each with the probe's cost loops,
so at most about 26 worker-seconds, 6.5 box-seconds, about 22 in all. The longest group a lane
runs stays under the 215 seconds of a worker that bounds a shard, so no shard count moves. A pull
request that changes only the family is the 8.7-minute row ("A harness file no document's key
names").

---

## 3. The registers and the walk stops

### 3.1 Finding 56 and finding 75's device half: to `fixed-defects.json`

In pull request 8, the lowering (part 04's), the nine entries move unchanged, `document` dropped
(`proof/README.md`, "Moving an entry when its defect is fixed"):

| Entry | Check | Control | Since |
|---|---|---|---|
| `d56-datetime-ordering-evaluate-answers` | `intent` | `targeted-datetime-ordering` | step 2 |
| `d56-datetime-ordering-evaluate-case-text` | `intent` | `targeted-datetime-ordering` | step 2 |
| `d56-datetime-ordering-clock` | `intent` | `targeted-datetime-operands` | pull request 1 (§7) |
| `d56-datetime-ordering-literal` | `intent` | `targeted-datetime-operands` | pull request 1 |
| `d56-datetime-ordering-case-list` | `intent` | `targeted-datetime-operands` | pull request 1 |
| `d56-datetime-ordering-suite-cmp-time-operand` | `manifest` | `targeted-datetime-operands` | pull request 1 |
| `d56-datetime-ordering-suite-lt-time-operand` | `manifest` | `targeted-datetime-operands` | pull request 1 |
| `d75-datetime-equality-case-list` | `intent` | `targeted-datetime-equality` | pull request 1 (part 06 §3.13) |
| `d75-datetime-inequality-case-list` | `intent` | `targeted-datetime-equality` | pull request 1 (part 06 §3.13) |

The two `manifest` entries leave the document with the lowering because a lowered ordering's sides
are arithmetic, which `_time_kind` reads as no time (a `binary` node is `False`, §5.2), so the
suite holds no `refused/time-operand` use; the control keeps the pre-fix suite and its derived case
types (§7), so both keep showing there. Finding 75's entries move here, not in pull request 10,
CSQL, because the equality lowering of part 04 §3.3 is what lists the cases on the device; its HQ
half has no register entry and is the `csql` family's (§2.5).

In the same pull request: `OPEN_DEFECTS` loses `56: 3` and `75: 3`;
`proof/checks/test_registers.py::test_every_live_defect_is_a_later_steps` asserts
`all(step > 3 …)` and its docstring says "Step 3's exit"; `proof/README.md`, "The defect rows",
gives the 56 row "Fixed in step 3: each operand is lowered by its type
(`lib/commcare/xpath/wire/instant.ts`); still shown by the controls `targeted-datetime-ordering`
and `targeted-datetime-operands`" and the 75 row its device half fixed, still shown by the control
`targeted-datetime-equality`; `harness-findings.md` finding 56 says it is fixed and where, and
finding 75 that its device half is (pull request 10, CSQL, records it fixed and names the `csql`
family's scenario); `datetimeOrdering.ts`'s header comment says the document is the fix's witness.
The pull request lane holds the move without a reader: the intent check runs Core, which is no
served reader, so an entry left live fails as unshown on its document, and a moved entry not shown
on its control fails there.

Production meets the lowering in a few datetime orderings (`now()` against a datetime question read
relatively), whose form bytes change at their app's next publish. It stores no equality between
two dates and times: every date-and-time equality it holds is the blank test `= ''`, which stays
bare (part 04's third production scan). None of its record orderings is datetime-typed by the
scan's reading.

What the lane adds to the native family: the cross-path half. Both documents' forms go out twice
(the XForm source in HQ's JSON, which HQ rebuilds, and the local archive), and the case list filter
twice (HQ's JSON filter text, which HQ interpolates, `corehq/apps/app_manager/xpath.py::interpolate_xpath`
(read), and Nova's local suite). Proof 3 runs both paths, the bar holds HQ's validators on the
lowered filter, and proof 4 holds the lowered spelling through two Vellum saves.

### 3.2 `targeted-datetime-ordering` stays admitted, and finding 74's stop keeps showing

Read for this part (`proof/targeted/documents/datetimeOrdering.ts`):

- **"Check"** (follow-up): `seen` and `due` are Hidden Values with `default_value: "#visit/seen"` /
  `"#visit/due"`, both properties declared `data_type: "datetime"`. From step 3 the text parses to
  `term form-case { visit, seen }`, typed `datetime` from the catalog (part 01 §3.2); a Hidden Value
  takes the type of its value expression and writes no case property, so writer agreement (part 03
  §4.3) does not apply; each is `{ data: "datetime", held: { nodes: "string" } }`, because a Hidden
  Value's bind keeps today's rule, its writer destination through `fieldValueType` (part 03 §5.2),
  and these two have no datetime destination. `if(#form/seen < #form/due, …)` is a datetime against
  a datetime: no form rule refuses it (part 01 §3.4 rules 1, 2, 5; part 03 §3.2 refuses a datetime
  only against an operand known not to be one), so it is admitted and lowered as two held strings.
- **"Visit instants"** (survey): `#form/start < #form/end` over two `datetime` questions,
  `{ data: "datetime", held: { nodes: "date" } }`: admitted and lowered.
- **"Book"** writes the properties with two datetime questions; no expression.

So the document is admitted from pull request 5, the shape, on with no change to its source:
`lib/__tests__/docHelpers.ts::f` parses its text through the production parser. Its emitted bytes
change (canonical print in pull request 5, the lowering in pull request 8); its expectations move
from failing to passing in pull request 8, which is what moves its entries. The survey form still
asks two date-and-time questions, which the Web Apps client draws no widget for, so Formplayer still
refuses its submission and finding 74's entry (`proof/walk-stops.json`, `targeted-datetime-ordering`,
`submit-refused:validation-error`) still shows on the document. Its reason names "the survey form's
two" questions and stays true. `proof/targeted/__tests__/targeted.test.ts` holds the admission in
pull request 5; the first night after the merge holds the stop.

The lowering grows the survey form's XForm from 1,442 to 19,050 bytes (part 04 §3.9; one lowered
comparison is 1.7 to 8.8 KB, about 5.4 KB for a typed-against-text one after an HQ save, the 5,355
bytes R2 measured). A person opening the form in HQ's form builder sees the lowered comparison in
the logic field, because the shadow must carry the same meaning or an HQ save would revert it;
proof 4 holds that two Vellum saves keep it, and step 6 recognises the shape on import
(`docs/plans/hq-round-trip/6-import.md`, part 04 §3.7).

**`targeted-datetime-equality` does not meet finding 74.** Part 06's document (§3.13 there) writes
`seen` in "Log visit" through a Hidden Value `seen_at` whose calculate is `now()`, whose `datetime`
destination gives it the same `nova_datetime_seen_at` sibling a question would get. It asks no
date-and-time question, so no walk of it meets finding 74's `submit-refused:validation-error`, and
`walk-stops.json` gains no entry for it. The case lists the `d75-…` entries read are Core
`evaluate` reads over the fixed restore, which no walk stop touches.

### 3.3 Findings 72 and 73: six stops removed, no control

A walk stop is strict both ways: an entry no run of its document showed fails the gate by name
(`proof/checks/stops.py`, `proof/checks/test_stops.py`). Every reader a stop names is served, so the
pull request lane holds none of the list; the night with every reader does.

- **Finding 72** rides pull request 5, the shape, which adds `SELECT_DEFAULT_NOT_AN_OPTION` (part
  03 §3.5), because the generator is rewritten there anyway (§4.2). It maps each drawn select
  default onto the select's first drawn option (`options[0].value`, quoted) in
  `xformDocArbitrary.ts::buildField`, after the draw, with no new `fc` call, and drops the
  `single_select` / `multi_select` rows of `DEFAULT_VALUE_BY_KIND`, as R3's scratch branch
  `proof/plan-step3-defaults-catalog` writes it. Executed on the host at `main`, reading every
  emitted document's select defaults at base and with the map: the sample holds 40 select defaults
  in 19 fuzz documents, every one the drawn `'a'`, and 20 of them in 12 documents are none of their
  select's options (11 single, 9 multiple, part 03 §3.5), the five stopping documents among the 12;
  after the map none is outside. The map moves the bytes of 16 fuzz documents (`local.ccz` differs
  from the base's in `fuzz-suite-20260930-0`, `-1`, `-2`, `-4`, `-5`, `-6`, `-8`, `-9`, `-10`,
  `-11` and `fuzz-xform-20260930-0`, `-1`, `-4`, `-7`, `-10`, `-11`); the other three
  (`fuzz-xform-20260930-2`, `-5`, `-8`) already draw `a` as their first option. No other draw and no
  fuzz id moves. The five entries are removed. Production holds no literal choice default outside
  its options (each literal default it holds is one of its options; the rest are computed), so the
  new code refuses no stored document; the cutover's `choice` lift turns the literals production
  holds opposite a static select into option identities, and the few that match no option stay
  text literals (part 09 §5).
- **Finding 73** rides pull request 5, the shape, with `casedata.py` (§4.4). Its document's case type
  declares `start_date` and `end_date` with no type and its date questions write them, so the
  effective catalog types both `date` (executed, §4.4); the lane's cases then hold
  `VALUES["date"]` there and the form opens. The entry is removed. Production holds no case row a
  typed preload fails to cast: the few typed preloads from undeclared properties read no stored
  row, and every other typed preload reads a declared-typed property.

No control is retained for either. A control is a group in every lane for good, served to every
reader each night its key moves (`fuzz-suite-20260930-5` alone is about 7,340 worker-seconds with
every reader), and neither finding is a symptom of Nova's emission that a control could keep
showing: each is a reader's answer to a shape any app can hold. Each refusal is held at its own
boundary instead:

- finding 72: `lib/commcare/validator/__tests__/selectDefault.test.ts` (part 03 §3.5: `'z'` and
  `'a z'` refused beside `'a'`, `'a b'`, `''`, a lookup-backed `'z'` accepted), and the generator's
  mapping by `proof/corpus/__tests__/fuzzSample.test.ts` (new: at the corpus seed, no sampled
  select's literal default is outside its options, and the sample's ids are the base's);
- finding 73: part 03 §4.3's `hiddenValueWriterAgreement.test.ts` (Nova's own writers can no
  longer put text where a typed question reads it back), and
  `proof/checks/test_proof3_behavior.py::test_the_case_database_seeds_each_property_from_the_effective_catalog`
  (new: an untyped property a date question writes takes date values).

Both removals were applied on R3 and R4's scratch branch (`walk-stops.json` 29 entries to 23,
formatting kept) and dispatched with every reader over the 26 documents they move (run
39064336028, §6.4). Removing a stop that ended a walk lets the walk go on; what a reader shows past
an opened form becomes a walk stop in pull request 5 (a reader's own end) or a finding. The run
showed neither. `fuzz-suite-20260930-8`, `fuzz-xform-20260930-1`, `fuzz-xform-20260930-7` and
finding 73's document open, submit and reach the end of every walk on Formplayer, the Web Apps
client and Android, and the stopped forms of `fuzz-suite-20260930-5` and `fuzz-xform-20260930-0`
open and submit on Formplayer. It showed two other things, both carried by pull request 5:

- **The walk's model of an answer a question already holds.** On five documents
  (`fuzz-xform-20260930-0`, `-3`, `-4`, `-9` and `fuzz-suite-20260930-5`, ten pieces) the Web Apps
  client submits a padded text answer (`'  proof  '`) where Formplayer's walk submitted `'proof'`,
  which `proof.webapps.observe.SubmittedOtherwise` reports. The walk always sends the table's first
  value (`proof/formplayer/walk.py::_fill`), and `_reconcile` takes Formplayer to hand the earlier
  text back trimmed on the next request, which the client then sends; but the client sends nothing
  for a question whose widget already shows the value (`proof/editors/driver/steps/webapps/answer.js`
  answers "unchanged"). The new opening values expose it: the catalog seeding puts `7`, the table's
  first `int`, into a preloaded `saved_prop`, and the mapped default `'no'` equals the walk's first
  answer. It is a gap in the harness's walk model, not a Nova or CommCare defect, so pull request 5
  fixes the model: `_fill` and `_reconcile` send no value equal to what the question already holds,
  as `answer.js` does, held by a new case in `proof/formplayer/test_walk.py` (a question that opens
  holding the value the table would send is sent nothing, beside one that opens holding another
  value, which is sent the table's). `walk.py` is in the observation partition, so the fix moves
  every served key, which pull request 5 moves anyway (§4.6). R5 reads the five documents again
  after the fix (§6.4).
- **Defect 21 past an opened list-first form.** `fuzz-suite-20260930-8`'s proof 4 shows 24
  differences no entry names, on `webapps@case list@B` and `webapps@case list@B-edit` in both
  configurations: `/runs/*` added and `/runs/*/viewport` changed, three of each per artifact and
  configuration. They are a knock-on of defect 21 (HQ's Case List save turns list-first into
  search-first, `auto_launch` false to true): once the form opens, Formplayer's walk of the state
  before the save has a run of a phone's own places, which only a location question gives
  (`proof/observe/walks.py::runs_for`), and the walk after the save has none, so the client replays
  a different set of runs. Pull request 5 registers them as two live entries under defect 21, part
  "list-first turned search-first", beside its existing ones, which step 5 fixes:

  | Entry | Check | Artifact | Path | Kind |
  |---|---|---|---|---|
  | `d21-list-first-turned-search-fir-webapps-case-list-runs` | `proof4` | `webapps@case list@*` | `/runs/*` | `added` |
  | `d21-list-first-turned-search-fir-webapps-case-list-runs-viewport` | `proof4` | `webapps@case list@*` | `/runs/*/viewport` | `changed` |

  The register refuses an entry whose document is a fuzz document (`proof/checks/registers.py`), and
  no other corpus document shows the class, so both name the new targeted document
  `targeted-list-first-places` (§4.5) as document and control: `targeted-list-first-web-apps`'s app
  with a location question in the form behind its list. Its control is retained in pull request 5
  (`python3 -m proof.checks.controls <corpus> targeted-list-first-places proof4`). The two entries
  hold `fuzz-suite-20260930-8`'s differences too, since an entry without `values` names its class
  on every document. They are served entries, so the pull request lane leaves them to the run with
  every reader; R5 holds them on the document and its control before the stack is cut (§6.4).

### 3.4 Defect 17: a witness with its fix

Defect 17 (research README, "Form-logic references stored as text") is not in the register and
gets no entry. Executed by part 02 (its rename probe, part 02 "Executed during planning"): renaming
a field a sibling reads as `../a` is admitted today and leaves `../a`. Production holds many
readers it would strand, relative reads and `casedb` queries, each of which the cutover lifts to
identity. No lane check can see that: a targeted expectation reads D's exports only
(`proof/targeted/expected.ts::Expectation.export`), and proof 5 compares digests, which a stale
text does not move. Adding expectations over D′ would change the intent observation
(`proof/observe/intent.py`), moving every key for one defect.

So `targeted-expression-renames` (§4.5) lands with the fix, in pull request 5, the shape, and the
lane holds what it can hold: proof 5 over its edit (every reader of a renamed or moved identity is
in the footprint the reference index computes, so a reader the index misses changes a wire outside
it), proof 3 and the bar over the reprinted spelling on both paths, and proof 4 over two Vellum
saves of it. That a rename follows the reference is held by part 02 §5.6's
`lib/commcare/validator/__tests__/gate.test.ts` case ("the relative-read rename … admitted with the
new print") at the commit gate, the boundary where the defect lives.

### 3.5 The registers at step 3's exit

| Register | Base | Exit |
|---|---|---|
| Live entries | 282 | 282 (pull request 1 adds seven, 56's five and 75's two; pull request 5 adds defect 21's two of §3.3, which stay live for step 5; pull request 8 moves all nine of 56 and 75, the base's two among them; 289 live after pull request 1, 291 after pull request 5) |
| Fixed entries | 720 | 729 |
| Controls | 105 | 108 (`targeted-datetime-operands`, `targeted-datetime-equality`, `targeted-list-first-places`) |
| Walk stops | 29 | 23 (pull request 5 removes six; pull request 1 adds none, §3.2), plus any stop a reader run shows on a new document or past an opened form (§3.3, §6.4) |
| `OPEN_DEFECTS` | ten defects | nine, every one a later step's: its values are steps, not entry counts, so `75: 3` (two entries) enters in pull request 1 and leaves with `56: 3` in pull request 8 |
| `identity-moves.json` | empty | empty: the cutover's one-time changes (§3.6) are held by its own tests, dry run and notice, and the lane never sees a document from before the cutover |

### 3.6 What only the cutover's dry run holds

The lane builds every document from source at the stack's head, so it proves the lifted shape only
as the sources write it, never a production document's lift. What the lift does to stored
documents is the cutover's to count, over the lifted documents at the window. The two read-only
production scans of planning decided which of these the cutover meets; the dry run counts each
again (part 09). The cutover part owns the walks and the notice reasons; this list is what the
proof plan relies on it to show. Every count below that can block is a blocker by rule: a non-zero
count stops the cutover until the author resolves it in the app (part 09 §11).

1. **Canonical print**: some expressions, in a minority of apps, print differently (redundant
   parentheses most of them, then needless double quotes, spacing, number spellings and a relative
   path re-derived), and none falls in a parenthesis-rule gap; the dry run counts it and holds
   `parse(print(e)) = e` over every lifted expression.
2. **The `choice` lift**: most form-logic literals opposite a static select become option
   identities, the few that match no option stay text literals, and record slots likewise.
   Expected after the lift: no `SELECT_DEFAULT_NOT_AN_OPTION`, and no literal a Hidden Value or
   case operation writes into a property a static select preloads that is none of its options
   (part 03 §4.3's `SELECT_PRELOAD_WRITE_NOT_AN_OPTION`).
3. **The first-row lift**: a few structural repeat reads used as one value, in very few apps (in
   `concat` and `selected`), take `[1]` on the repeat step, each named in the notice (reason
   `repeat-read-takes-first-row`); expected no `XPATH_MANY_VALUES` after it, prose parts included,
   which the scans did not read.
4. **Untyped case queries**: production holds some, in a few apps, reading a row value with no
   `@case_type` literal. Part 09's probe splits them four ways: standard reads, which need no type;
   custom reads that bind to the one case type of the effective catalog that declares the property;
   custom reads several types declare, each a `case-query-untyped` blocker the author resolves
   before the window; and reads that a `@case_id` from a known source types after all, which become
   declarations (part 09 §5, step 5). A bound query stores its case type and prints no predicate,
   so its text reads back unchanged; a re-parse of the edited slot takes the slot's current tree as
   its binding hint (part 02 §1.3).
5. **Absence for `{ parts: [] }`**: production holds it in `relevant` only, lifted to absence.
6. **The catalog's retired XPath slots**: every property that stores a `required`, `validation` or
   `validation_msg` loses it, each named in the notice (decided with the person, 2026-10-17).
7. **Session reads**: production's, in a few apps, are all `selected-case`, lifted to
   `selected-case { module }` against pull request 5's parser, where `DatumRef` and
   `entryDatumSupplies` land; expected no `SESSION_DATUM_NOT_SUPPLIED`. Production holds no
   `selected-cases` read used as one value, so there is no lift; a stored one would be a
   `target-gate` blocker (part 09 §11).
8. **Nothing to lift**: production holds no record `div` to read as `quotient`, no CSQL `today()`,
   no CSQL datetime equality, no typed datetime literal and no `date_opened` / `last_modified`
   comparison (part 04's third scan; part 06 §10); the dry run confirms each is still none, and a
   refusal it counts is a blocker.
9. **The whole finding multiset** of the lifted documents against the same documents at the base,
   `CYCLE` among it (relative reads gain dependency edges, part 07), so a code no row above names
   still surfaces (part 03 §5.4's list).
10. **The fold horizon's suffix**: production held no `app_changes` row after any app's step 2 fold
    baseline at either scan; whatever accrues until the window is the opaque suffix the lift folds.

No item reaches the lane: a lifted document the gate refuses never commits, and an admitted one is
an ordinary document whose shape the corpus's sources already write.

---

## 4. The corpus

### 4.1 Every source speaks the union in pull request 5, the shape

The corpus is built from source by the current code on every run, and a document the strict
schema or the gate refuses stops the emission (`proof/corpus/fuzzSample.ts::admitted`,
`proof/corpus/emitCorpus.ts::admittedDoc`). So pull request 5 changes every source that
builds an expression:

| Source | Change |
|---|---|
| `lib/__tests__/docHelpers.ts` (`buildDoc`, `f`, `xp`, `xpIn`) | text parses with the production form-XPath parser against the document being built; Predicate constructors become the union's builders. Unnamed identities keep their counter order, so no fixture moves another's ids. |
| `lib/commcare/__tests__/xformDocArbitrary.ts` | every `opaqueXPathExpression(<constant>)` becomes the same constant parsed against the built document (§4.2) |
| `lib/commcare/__tests__/suiteDocArbitrary.ts` | the Predicate and ValueExpression constructors become the union's builders; same trees |
| `proof/corpus/editKinds.ts` | its expression-bearing kinds build union values from the target document; the census of kinds must land as at the base |
| `lib/commcare/__tests__/expander.test.ts` | its captures' fixtures are rewritten in place, keeping every test's title and document count, so every `expander-<slug>-<hash>-<n>` id stays (`proof/corpus/documents.ts::readExpanderCapture`) |
| the fixture modules under `lib/commcare/__tests__/` that `producers.ts` imports (`searchEmissionFixture.ts`, `csqlFunctionFixture.ts`, `csqlQuoteFixture.ts`, `caseListEmissionFixture.ts`, `lookupAppFixtures.ts`, `relationInstanceFixture.ts`, `workerWireFixture.ts` and the rest `rg -l` finds over `predicate` / `xpath` imports) | builders and parsed text; no scenario added or reordered |
| `lib/commcare/__tests__/hqJsonOracle.test.ts` | the same |
| `proof/targeted/documents/*.ts` | builders where a document constructs record expressions; text stays text (parsed by `docHelpers`) |
| `proof/corpus/producers.ts` | imports only |

The pull request proves it changed no document but by expression bytes: it runs the emission at
base and head with no Docker, and compares the stop (none), the census, and `index.json`'s document
ids (equal), as step 2's plan made the first check of every model change, and part 03 §7's
`(document, code, location)` finding multiset over both corpora.

### 4.2 Fuzz: mapped, never drawn again

`fc.sample` draws from one stream per seed, so a further draw inside a generator shifts every later
draw of the sample (`fuzzSample.ts` header). Every change to the two existing generators is a map
after the draw:

- the form-logic pools (`SAFE_BOOLEAN_XPATH`, `SAFE_VALUE_XPATH`, `SAFE_COUNT_XPATH`,
  `DEFAULT_VALUE_BY_KIND`, the two `ids_query` texts, Connect's `user_score`) keep their text; each
  drawn text parses with the production parser against the drawn document, so the two casedb
  `ids_query` texts become `cases` / `project` arms, a reference held as text no longer; both
  (`instance('casedb')/casedb/case/@case_id` and `…/case[@status = 'open']/@case_id`) read only
  `@case_id` and `@status`, which an untyped query may read (part 01 §1.3), so neither meets
  `case-query-untyped` and no fuzz document is refused by it;
- finding 72's mapping (§3.3) is on the drawn text, before the parse, and the mapped default then
  parses to a `choice` leaf;
- `sessionReadDocArbitrary` (not in the sample) reads through the same parse.

So the 24 fuzz documents are the same documents: ids, structure and every other draw stay, and only
their expressions' bytes move.

### 4.3 The typed expression generator

`lib/commcare/__tests__/expressionDocArbitrary.ts::expressionDocArbitrary` (new) is
`fc.record({ doc: suiteDocArbitrary, plans: fc.array(expressionPlan, { minLength: 3, maxLength: 8 }) })`
mapped onto the drawn document, as `sessionReadDocArbitrary` composes `blueprintDocArbitrary`. A
plan draws a slot, a shape, an operator, a spelling and index picks; the map resolves the picks
modulo what the drawn document holds and builds the expression with the union's builders, typed by
construction. A plan that finds no target is skipped and draws nothing more. Its shapes:

| Shape | Builds | Slots |
|---|---|---|
| reference | a field read in a drawn spelling (`#form/`, `/data/`, relative, `current()`), relative only where a common ancestor exists, compared with a literal of the field's type or another field of that type | `relevant`, `validate`, hidden `calculate`, `default_value` |
| repeat | inside a repeat, a relative sibling read (the same iteration); from outside, `count(#form/rep/q)` and `join(' ', #form/rep/q)` (a repeat's answer read from outside it sits only in a function that takes many, since one used as one value is the `many-values` refusal, part 03 §3.4) | the same, `repeat_count` |
| case query | where a module has a typed property: `count(instance('casedb')/casedb/case[@case_type = 'T'][p <op> <literal of p's type>])`; where exactly one case type declares `p`, the same count without the `@case_type` predicate (the query binds to that type and stores it, part 01 §1.3); and in a follow-up form a one-row projection `…/case[@case_id = #T/case_id]/p`, typed by the `@case_id`'s known source (part 01 §1.3). A query used as one value is drawn only through `@case_id`, because Core throws at run time on more than one row and a walk would then stop on data alone | hidden `calculate`, `relevant` |
| temporal | a date field against `today()`, a datetime field or a datetime case read against `now()` and against another datetime (the lowering), `=` and `!=` between two datetimes (the equality lowering, part 04 §3.3), `date(#form/dt) = #form/d` (the explicit coercion), `format-date` with a fixed pattern; datetime literals to the millisecond or coarser (`datetime-literal-precision`); never a `casedb` row's `date_opened` or `last_modified` against a moment (`day-only-on-device`, part 04 §3.4) | the same |
| number | integer and decimal arithmetic (`+`, `-`, `*`, `div`, `mod`, `quotient`, `negate`) compared with a number | the same, `repeat_count` |
| call | one of the 60 call functions whose arguments the document can supply by type (`string-length`, `substr`, `round`, `int`, `contains`, `selected-at`, `count-selected`, …) | the same |
| record | a datetime and a date property each ordered against a literal of its type and against another property of its type, equality between two datetime properties, a `case-row-type` against a `case-type` | case list filter, calculated column |
| CSQL | in a module with search, one of part 06's authorable clauses: a typed property against a search input, `today()` on a date property (the worker's day, a runtime segment), `eq` / `neq` / `in` on a datetime property (the closed instant range, part 06 §3.13), `within-distance` with a drawn unit and a runtime radius, `in`, `between`, `when-input-present`, a runtime choice on a worker value; never a chosen-case value (the gate admits it from pull request 10, CSQL, after this generator lands in pull request 5, so `targeted-csql-composition` holds it, §4.5, and the sample stays the same eight documents) or `drift`, `window_width`, `applanguage` (step 4) | advanced search predicate, search defaults |

- **Sample.** `FUZZ_GENERATORS` gains `"expression"`; `fuzzSplit(size)` keeps its split of the
  existing two, and the new generator takes its own `DEFAULT_EXPRESSION_SAMPLE_SIZE = 8`
  (`proof/corpus/defaults.ts`). Ids `fuzz-expression-20260930-0` to `-7`. Eight gives each shape
  several plans at three to eight plans a document, at under 3% of the lane; the first night's
  measure may move it.
- **A shape that stops landing is seen.** `proof/corpus/__tests__/expressionSample.test.ts` (new,
  pure): at the corpus seed, every shape lands in some sampled document, and every sampled
  document is admitted. A generator change that stops drawing a shape fails there, not as a quiet
  loss of coverage.
- **Consequences.** No register entry may name a fuzz document (the loader refuses it), so a defect
  only this sample shows gets a targeted document of its own. A reader's stop on one of the eight is
  either a Nova defect (a finding, and a targeted document) or a refusal the checker lacks (a step 3
  fix, which removes the shape's draw by mapping, never by drawing again); either way the gate
  names each stop to add or remove. R5 (§6.4) is the dispatch that shows them before the merge,
  with `targeted-expression-renames` and `targeted-session-reads` beside them.
- **Cost.** Fuzz documents are the lane's heaviest: the 24 take 15.6 box-seconds at the median
  without the readers and 1,062 with them. Eight more add about 125 box-seconds to the 4,403 of a
  whole lane without the readers (under 3%) and about 8,500 to the 496,353 with them (under 2%).

### 4.4 `casedata.py` reads the union and the effective catalog

`proof/observe/casedata.py` derives every document's case database from `document.json`: values
from each declared property's `data_type` (`_type_values`, `VALUES`), values the document compares
properties with (`document_values`, a walk of `doc.modules` for `eq` … `lte`, `in`, `between`,
`multi-select-contains` with `prop` operands and `literal` values), and user data for each
`session-user` field (`_session_user_fields`). Record slots keep their bytes from step 3 (part 01,
Decisions in brief, item 1), so those readers would keep working, but two things change, both in
the shape pull request, which moves every key anyway:

- **The effective catalog.** `proof/corpus/entryWriter.ts::documentJson` writes `catalog`: each case
  type of `lib/domain/effectiveCaseTypes.ts::materializableCaseTypes(doc)` as `{ name, parent_type,
  relationship, properties: [{ name, data_type, options }] }`, beside `wire`. That flavor is the
  effective view (declared types, writer-filled types, writer-derived entries) minus the standard
  entries the effective view injects, and it is what Nova's own Preview and sample surfaces read
  (`lib/domain/CLAUDE.md`, "Property types are derived facts"). `_case_types` and `_type_values`
  read `document_json["catalog"]`, so a property Nova types by its writers (and from step 3 by
  Hidden Value inference, part 03 §5) holds values of that type, and a writer-derived property no
  declaration names is seeded at all; an untyped property stays text. `casedata.py` keeps writing
  the standard properties as the case's own attributes, as it does today. Python never re-derives
  a type. `proof/checks/controls.py` already keeps `caseDatabase` in `derived.json`, so no control
  moves.
- **The whole union.** `document_values` walks `doc.modules`, `doc.forms` and `doc.fields`, and
  takes a `form-case` operand as it takes a `prop` (both name a `(caseType, property)` of a case a
  session holds), so the cases also hold the literals form-logic queries and conditions compare.
  `_session_user_fields` reads `session-user` with or without `source`; a `worker-record` read is
  served from the usercase, which already carries every user-data field.

Executed during planning (a read-only probe over the 371 documents emitted at `main`, comparing
each declared property's `data_type`, what `casedata.py::_type_values` reads, with
`lib/domain/effectiveCaseTypes.ts::effectiveCaseTypes`'s): reading the effective catalog moves the
seeded types of 4 documents: `expander-output-references-in-labels-lowers-several-typed-e72b42c4-0`
(`c/start_date`, `c/end_date`: text to date, finding 73's), and three documents whose `patient/age`
becomes `int` (`expander-expanddoc-leaves-case-references-data-load-empty-e5b29395-0`,
`expander-the-app-level-keys-of-the-hq-import-file-holds-4bc31810-0` and `-1`). Step 3's own
inference moves more; pull request 5's base-and-head emission lists them.

Executed during planning, on R4's scratch branch (`proof/plan-step3-defaults-catalog`, §6.4): the
whole seeded case database, base `casedata.py` over the corpus without `catalog` against the
branch's over the corpus with it. With `materializableCaseTypes`, 15 of 371 documents' databases
change: the 4 above, and 11 `fuzz-xform-20260930-*` documents whose writer-derived `saved_prop`,
which no declaration names, now holds int values (`7`, `10`, `2`) where today it holds none. With
`effectiveCaseTypes` in its place, 252 change, every one through an `external_id` the injected
standard entry seeds on cases that hold none today (351 case types' `@external_id`, beside the 15's
own changes), a value no Nova writer put there; that is why the flavor above is the one decided.
The 11 fuzz documents are `fuzz-xform-20260930-0`, `-1`, `-2`, `-3`, `-4`, `-6`, `-7`, `-8`,
`-9`, `-10` and `-11`. These are host results. With every reader (run 39064336028, §6.4), finding
73's document runs clean, the three `int` expander documents pass (11 of 11 items), and 7 of the
11 fuzz documents pass; the other 4 (`fuzz-xform-20260930-0`, `-3`, `-4`, `-9`) are the walk
model's gap of §3.3, which the seeded `saved_prop` exposes and pull request 5 fixes.

Tests (`proof/checks/test_proof3_behavior.py`, pure): the existing
`test_the_case_database_holds_what_the_documents_lists_select_in_orders_that_differ` gains the
`catalog` key in its fixture; new
`test_the_case_database_seeds_each_property_from_the_effective_catalog` (an untyped property typed
`date` by its writer takes date values; a declared type wins) and
`test_the_case_database_holds_the_literals_form_logic_compares` (a `count(…case[p = 'x'])` in a
calculate puts `x` among `p`'s values).

### 4.5 Targeted documents

Each is a `targetedDocument` spec in `proof/targeted/documents/`, listed in
`proof/targeted/index.ts::TARGETED_DOCUMENTS`, with identities named from its id, values fixed by
hand (`proof/targeted/expected.ts`), admission held by `proof/targeted/__tests__/targeted.test.ts`.
None of the nine asks a date-and-time question, so none meets finding 74's stop (§3.2).

| Document | Pull request | Shows | Expectations (Core `evaluate`, `local` and `A`) | Edit |
|---|---|---|---|---|
| `targeted-datetime-operands` (`datetimeOperands.ts`) | 1, lane mechanics | finding 56 on the operand classes `targeted-datetime-ordering` lacks, over a fixed restore of two `visit` cases (Amina seen 10:00 and due 11:00 UTC on 2026-03-01, Baraka seen 12:00 and due 11:00): "Check" copies `seen` into a Hidden Value and orders it against `now()` under the clock `2026-03-01T11:00:00.000Z`; "Seen before eleven" is a case list filter `lt(prop(visit, seen), term(datetimeLiteral("2026-03-01T11:00:00")))`, the literal row, since form logic already refuses a date and time written as text in an ordering (`XPATH_TIME_ORDERING`); "Seen before due" is a case list filter `lt(prop(visit, seen), prop(visit, due))` (the suite target, both properties declared `datetime`) | `seen-before-now-local` and `seen-before-now-a` (`/values/0/value` `seen before now`), `listed-before-literal-local` and `listed-before-due-local` (case lists, `local` only: `/caseList/rows/0/caseId` Amina) | none |
| `targeted-datetime-equality` (`datetimeEquality.ts`, part 06 §3.13) | 1, lane mechanics | finding 75's device half: "Visits" (whose "Log visit" writes `seen` through a Hidden Value with `now()`) with `caseListConfig.filter` `eq` of the `datetime` property `seen` and a naive literal, "Other visits" with `neq` of the same, "Opened visits" with `date_opened` equality in an advanced Search input's predicate (refused in a case list filter from pull request 8, the lowering, `day-only-on-device`), over a fixed restore of three `visit` cases in HQ's stored spelling (`…T04:30:00.000000Z`, an hour later, and one without `seen`); rows `["75"]` | `equal-visits-listed-local` (Amina) and `other-visits-listed-local` (Baraka, then Chidi), case lists from `local`; "Opened visits" has none, since no device reads it | none |
| `targeted-expression-renames` (`expressionRenames.ts`) | 5, the shape | defect 17's witness: relative reads inside a repeat (`../q`, `.`), a `current()/..` read in a query-bound repeat, an absolute `/data/` read, a casedb query reading a property in a predicate and a projection, a query with no `@case_type` whose property one case type declares (bound to it and stored, part 01 §1.3), a `cases` query used as one value through `@case_id` (admitted, part 03 §3.4), a static select's literal default and comparison (`choice`) | each read's value over a fixed restore and answers | D′, one batch: rename a field read relatively and by hashtag, `renameCaseProperties` of the queried property and of the untyped query's bound property, `updateOption` of the default's option value, and move a read field within its repeat |
| `targeted-session-reads` (`sessionReads.ts`) | 5, the shape, with session datum identity (part 05 §1) and the Core session-read scenarios of §2.6; pull request 9 adds its batch form | one read of each `DatumRef` kind (`selected-case`, `new-case`, `new-child-case`, `worker-record`, `tile-group-parents`); from pull request 9, instances and session, a batch form's `count(instance('selected_cases')/results/value)` (part 05 §2.5), which lands with the other new instance reads, so by the exit the document reads every session datum kind and a batch form's selected cases | each value equals the id the session or the case block holds | D′: the read's source module gains a parent menu, which renames the entry's datum; the read reprints, and proof 5 holds it inside the footprint (`u:<module>`) |
| `targeted-list-first-places` (`searchApps.ts`, `listFirstPlaces()` beside `listFirstWebApps()`) | 5, the shape, with its control | defect 21 past an opened list-first form (§3.3): the app of `targeted-list-first-web-apps` (a list-first menu that offers search, Web Apps on, the `CLOUDCARE` privilege, `SYNC_SEARCH_CASE_CLAIM`), whose follow-up form also asks a location question, so Formplayer's walk before HQ's Case List save has a run of a phone's own places and the walk after it none; rows `["21"]`; the document and control of the two entries §3.3 adds | the follow-up form's note holds the text the worker enters, as in `targeted-list-first-web-apps` (`./echo.ts`) | none |
| `targeted-instance-reads` (`instanceReads.ts`) | 9, instances and session | a form-logic lookup read (`table-lookup` and a `table-rows` count), a form link condition reading `item-list:<tag>`, a flat `instance('locations')` read of a place's name and a location property, and a form link condition reading a place's name (part 05 §2.4: a form link may read places, which puts a `locations` declaration in the suite for `hierarchical_locations`, §5.2), with organization levels, places and the flat fixture confirmed (`projectSettings`) | each value from the document's lookup rows and places | none (a lookup rename is Project data, no `Mutation`: §5, proof 5) |
| `targeted-inline-search-reads` (`inlineSearchReads.ts`) | 9 | `instance('results:inline')` reads in the forms of an inline-search module (kept in step 3, decided with the person, 2026-10-17; part 05 §2.8), and `#search/<name>` in the no-matches form | each value from a fixed search answer and results set | none |
| `targeted-text-reads` (`textReads.ts`) | 9 (the reads' `toWire` rows and declarations, part 02 §9) | `jr:itext` of a label and of an option label, `jr:choice-name` on an inline select, in two languages | each value under `locale` | none |
| `targeted-csql-composition` (`csqlComposition.ts`) | 10, CSQL | one search per authorable construct (part 06 §8), among them the chosen case: a "Visits" menu whose entry passes through a "Households" case list, whose search narrows by the chosen household, its parent's `case_id` compared with `chosen-case('Households')` in the flag-free ancestor spelling under the configuration without `CASE_SEARCH_RELATED_LOOKUPS` (part 06 §3.12), and by `village = chosen-case-property('Households', 'village')` in a runtime segment, and whose case list filter reads `chosen-case-property('Households', 'village')` (the `selected-case` datum of a menu the entry passes through and a `project` over `casedb` keyed on it, checked by the entry-supply rule, part 05 §1.6, part 06); and a "Members" child module nested in a root, case-first "Households" menu with parent-select Households, whose case list filter reads the chosen household, so HQ's build renames the HQ JSON filter's `parent_id` to the root's `case_id` through root alignment (part 05 §1.3, "The case list filter's two prints") | `csql@A` compiles each under every configuration; proof 3 holds the aligned child's list nodeset equal on HQ's build and the local suite; none is a value expectation (meaning is the `csql` family's) | none |

Finding 75 is observed in the lane as finding 56 is: its device half on
`targeted-datetime-equality`, with a retained control and the live entries
`d75-datetime-equality-case-list` and `d75-datetime-inequality-case-list` that pull request 1 adds
(§7) and pull request 8 moves (§3.1); its HQ half (HQ matches `value.exact` text, so an instant in
another spelling finds nothing, part 06 §3.13) in the `csql` family's `datetime-equality` scenario
(§2.5), because no lane check reads HQ's search results. Production holds no `eq`, `neq` or `in` on
a `datetime` anchor in any `_xpath_query`, case list filter or advanced predicate (part 06 §10), so
the fix moves no stored app's bytes.

### 4.6 What moves in the lane, and where

| Pull request | What every document's records do |
|---|---|
| 1, lane mechanics | two new documents and two new controls are observed; every record is judged again (a judge's files changed), and no existing document's key moves |
| 2, cutover skeleton, and 3, projection | nothing of their own; pull request 1's records are not in main's store, so its documents and controls are observed again and every record judged again |
| 4, wire tree | most documents' bytes move (record family and scaffolding, part 04 §5.1, §5.2): observed afresh |
| 5, shape | every `a` key moves (`document.json` is an input of `a`, `proof/corpus/inputs.ts`), the case database moves wherever `catalog` or the walk of §4.4 gives other values, and every document with an expression prints canonically |
| 6 to 15 | observed afresh by stacking, whatever each changes (§6) |

---

## 5. Proofs 1 to 5 and the other checks

| Check | What step 3 must show there | Where it is shown |
|---|---|---|
| Bar | every lowered and canonical spelling parses in Core on both paths; HQ's validators pass the case list and display filters that hold a lowering (js-xpath on module and form filters, the etree dummy filter on the case list filter, `REFUSED` row `detail-filter-failing-etree-xpath-dummy-filter`); each instance declaration the serializer derives passes `assert_no_unknown_instances` (a bare lookup tag in a suite slot would not: part 05 §2.3) | the pull request lane, over the targeted documents and the generator's sample |
| Intent | the hand-fixed values of §4.5 and of `targeted-datetime-ordering`, in UTC, finding 75's device-half lists on `targeted-datetime-equality` among them; `csql@A` over every query proof 3's sessions send, the closed instant ranges of part 06 §3.13 included | the pull request lane |
| Manifest | every key a new spelling uses is held (below) | the pull request lane |
| Sensitivity | part 06 changes which flags a search needs (CSQL `today()` as a runtime segment, the flag-free ancestor spelling of §3.12), so a configuration's minimum flags can move; if `test_sensitivity.py` fails, the pull request writes `gates.json`'s effects again from a run where every document's group ran (`gh workflow run ci.yml --ref <branch> -f proof_fresh=true`, then `python3 -m proof.checks.sensitivity effects …`) | pull request 10, CSQL; expect one such dispatch |
| Proof 1 | a session datum read keeps its derived id across two publishes of one revision and across edits outside its footprint; nothing mints per export | the pull request lane over `targeted-session-reads`, from pull request 5 |
| Proof 2 | the same code both sides: catches an emission that depends on order or a draw | every pull request |
| Proof 3 | a form expression's two paths (HQ's rebuild of the XForm source and the local archive) and a suite expression's two paths (HQ's interpolation of the JSON text and Nova's suite) agree in Core's sessions over the lane's cases, the lowered orderings and equalities included, and the chosen case's id and properties in a search's runtime segment from pull request 10 | the pull request lane; Formplayer, Web Apps and Android the night after |
| Proof 4 | every spelling step 3 emits survives two Vellum saves and every HQ section saved unchanged: relative and `current()` paths, `/data/` and hashtag reads, casedb queries, the bare-tag lookup instance, `jr:itext`, `jr:choice-name`, a lowered comparison of 1.7 to 8.8 KB (part 04 §3.9; the Visit instants form grows from 1,442 to 19,050 bytes, §3.2). Nova writes no `#case/` shadow (step 2's rule stands: no form Nova writes holds a `#case/` hashtag, `proof/README.md` defect row 3); a save that writes its own `#case/<property>` over a selected case's projection, as R2's did, is HQ's editor at work and a difference proof 4 already erases | the pull request lane (HQ's editors run without the served readers); executed during planning on R1's and R2's scratch documents without readers (runs 39061011794, 39061476968): no proof 4 failure, Vellum's save leaving the lowering's structure and writing the spacing the canonical print writes (part 01 §2.5); R2 again with every reader (run 39064333759): no difference served to Formplayer, the Web Apps client or the device (§6.4) |
| Proof 5 | every new reader the reference index keys (part 02 §5.1: field with `climb` and filters, `repeat-row`, option, itext unit, datum's module, location level and property, search input, case-query rows) is inside the footprint of an edit that renames, moves or retypes what it reads | `targeted-expression-renames`, `targeted-session-reads`, and the fixed floor's balanced batches; the fuzz index oracle (`lib/doc/__tests__/referenceIndex.fuzz.test.ts`, part 02 §5.2) for the kinds no corpus batch draws |
| Stops | §3.3; each new document's walks reach their end or a held stop | the night after; before it, the reader dispatches of R1 to R4 and R5 (§6.4) |

Proof 5 cannot see a lookup table or column rename: it is Project lookup data
(`lib/lookup`), not a `Mutation`, and `editKinds.ts` draws only `Mutation` kinds. Its oracle is
`lib/doc/__tests__/lookupReferences.test.ts` (part 02 §5.6) over the extractors part 05 adds.

### 5.1 Manifest entries that flip from HELD-NEW to HELD

`proof/checks/manifest_usage.py::_standing_plan` treats HELD and HELD-NEW alike (any non-REFUSED
entry allows), so a flip is the record of what Nova holds and changes no verdict. Each flip is an
edit to its entry in `lib/commcare/surface/entries/<area>.json` (disposition and cell) and its row
in `docs/research/2026-09-26-hq-round-trip/inventory/<area>.md`, held by
`lib/commcare/surface/__tests__/manifest.test.ts`, in the pull request that makes the construct
emittable. The surface is a judge file, so a flip costs the 10.2-minute row at least; from pull
request 4 up it costs nothing more.

| Owner | Flips to HELD |
|---|---|
| part 05 | `expressions-and-data/session-data-datum`, `item-list-tag-read-in-any-other-expression`, `locations-flat-jr-fixture-locations-read-in-an-expression`, `instance-id-current-path-roots`, `xpath-location-paths`; and, since search results stay in step 3, `results-read-in-form-expressions-of-an-inline-search-module` (pull request 9); and `session-data-datum-hq-shorthand-in-navigation-slots`, the case chosen in an earlier menu read in a record slot (pull request 10, part 05 §3) |
| part 01 | the 76 function entries ("a typed function node": the 16 on arms, the 60 on `call`); `relative-paths-q-current-x`; `xpath-operators-and-literals`; `jr-itext-id`; `jr-choice-name-value-path-on-a-static-choice-select`; `here-in-a-case-list-calculated-column-or-sort` |
| part 06 | `case-search/metadata-closed-on`, `authored-case-type-comparisons-other-than-a-hop-qualifier`, `date-int-datetime-number-epoch-days`, `unwrap-list`, `selected-with-a-runtime-assembled-v`, `within-distance-in-yards-feet-inch-meters-centimeters`, `within-distance-with-a-runtime-radius-or-unit`, `clause-chosen-at-runtime-by-a-condition-over-session-worker`, and `runtime-values-read-from-casedb-or-session-datums` ("case and datum terms in CSQL values"), which the chosen case's id and properties in a runtime segment make emittable from pull request 10 (part 06 §6) |
| stay HELD-NEW | `case-search/date-only-comparison-on-date-opened-closed-on-last-modified` and `several-xpath-query-rows` (step 6); `case-search/runtime-values-read-from-the-session-context-drift-window-width` (it names only `drift`, `window_width` and `applanguage`, step 4; confirmed from the entry by part 06 §6); `groups-jr-fixture-user-groups` and `session-data-supply-point-id-in-an-advanced-form-whose-computed` (step 7); `search-input-read-in-form-expressions-of-an-inline-search-module`, `search-input-results-read-in-the-search-results-detail`, `session-data-stringquery`, `session-data-fingerprintquery`, `session-context-drift`, `-window-width`, `-applanguage` (step 4); every "outside Predicate / ValueExpression" entry of a record slot (`form-filter-…`, `module-filter-value-…`, `detail-filter-value-…`, `usexpathexpression-field-xpath-…`, `sort-calculation-…`, `tab-relevant-…`, `data-tab-over-a-custom-nodeset-xpath`, `case-list-form-relevancy-…`, `questions/itemset-filter-outside-predicate`, `savetocase-expressions-outside-…`, `case-search/…-outside-predicate`, `…-outside-valueexpression`, `default-properties-entry-…`, `hidden-without-exclude-…`, `detail-persist-case-context-…`, `case-preload-from-any-other-index-path-…`), because step 3 admits no `call` in a record slot (part 01 §2.4; step 6 admits it for import); `questions/output-value-any-other-expression`, because step 3 adds no `<output value>` expression in prose (part 01) |

### 5.2 REFUSED value classes and their readers

A use whose key a REFUSED entry with a value class names is `UNDECIDED` where the check holds no
reader for that class, and that is a difference (`manifest_usage.py::_evaluate`, `_path`). Read for
this part, over every REFUSED entry with a value class on an `xpath-`, `jr-fn:`, `instance-`,
`session-` or `csql-` key (a read of `lib/commcare/surface/entries/*.json` against
`proof/checks/manifest_value_classes.py::VALUE_CLASSES`): every class step 3's emission newly
reaches has a reader: `here-in-a-form` (`here_in_form`),
`jr-choice-name-on-a-lookup-itemset-select` (`choice_name_on_lookup`),
`results-read-in-form-expressions-reached-through-a-search-that` and
`search-input-read-in-…` (`non_inline_search_form`), `or-with-a-time-on-either-side-…`
(`time_operand`), `after-a-named-step-data-a-b`, `var-in-a-form-expression`,
`session-data-supply-point-id-anywhere-…`, and CSQL's `untyped-right-side` and `non-date-value`.
`referenced-undeclared-instance-id-…` is the bar's (`not-hq-buildable`, skipped by
`refused_by_hq_build`).

Three readers are needed, one of them found by R1's run without readers:

- **`expressions-and-data/commtrack-locations-hierarchical`** (class `hierarchical-locations`, keys
  `instance-scheme:locations`, `instance-scheme:commtrack`, no reader today). Today Nova declares
  `instance('locations')` only in an XForm, where `_instance_uses` records no scheme
  (`schemes=False`; executed: `location-direct`'s one declaration is in `modules-0/forms-0.xml`).
  From step 3 a form link condition may read flat locations (part 05 §2.4: admitted, because a
  link's condition evaluates in the source entry's session over the entry's declared instances),
  which puts the declaration in the suite on the source entry, where HQ's
  `location_fixture_instances` chooses the src. Pull request 9, instances and session, which admits
  that read, adds `hierarchical_locations(use, manifest)`: True where the declaration's `src` is
  `jr://fixture/commtrack:locations`, False for `jr://fixture/locations`, None for another source,
  with its pair in `proof/checks/test_manifest_value_classes.py`; `targeted-instance-reads`'s link
  condition reading a place's name (§4.5) is the lane's use of it.
- **`time_operand` over a case property: its type** (pull request 1, §7). Read at `main`,
  `time_operand` walks every relational comparison of an expression (`_relational`: `<`, `<=`, `>`,
  `>=` at any depth, predicates included) and asks `_time_kind` of each side. `_time_kind` answers
  `False` for a number, a negation, a `binary` node other than a union (arithmetic, a comparison,
  `and`/`or`) and a call in `NON_TIME_CALLS`; `":" in text` for a string literal; the branches'
  verdicts for `if` and `coalesce`; `False` for a bare relative read of `date_opened`, `closed_on`
  or `last_modified` in a suite or profile (`SYSTEM_DATE_NAMES`, `_system_date_read`, because Core's
  casedb holds the first and last as `DateData` and `closed_on` reads blank); in an XForm, an
  absolute or relative path through its node's bind type (`_time_node`: `DATATYPE_TIME` among
  `_core_datatypes`, or a text node's calculate read again); and `None` for everything else, a
  custom case property read in a suite among it. A comparison is refused where any side is `True`
  and undecided where none is and one is `None`. So in a suite, `seen < '2026-03-01T11:00:00'` is
  decided (the literal holds `:`), and `seen < due` between two `datetime` properties is
  `undecided/time-operand`, which no register entry may name (`proof/checks/registers.py` module
  docstring: an undecided use is a gap in the check, not a symptom). R1 showed exactly that on
  `targeted-datetime-operands` (§7). The reader added: in a `runtime` document, a bare relative
  read of a custom property inside a `casedb` case step's predicate whose sibling predicate is
  `@case_type = '<literal>'` resolves to `(caseType, property)`, and its type is read from the
  document's derived case types (§7): `datetime` or `time` is `True` (Core reads the stored text,
  which holds `:`, as NaN, `FunctionUtils.toNumeric`), `date`, `int` and `decimal` are `False`,
  and anything else, a property with no type or a case type the predicate does not name, stays
  `None`. It changes no verdict main's corpus holds: main's lane passes, so no document there holds
  an undecided `time-operand` use, and a side already `True` stays `True`. Its pairs go in
  `proof/checks/test_manifest_value_classes.py` (a `datetime` and a `time` property refused beside
  a `date` and an untyped one, and a case type the predicate does not name).
- **`time_operand` over a lowered comparison.** `_time_kind` reads a `binary` node as a number
  (`False`), so a lowered ordering, whose sides are arithmetic, reads as no time. Nothing to add;
  pull request 8's manifest run shows each such use `HELD`, which is what takes finding 56's two
  `manifest` entries off the document (§3.1).

CSQL's distance unit and `closed_on` need no new recording: `proof/checks/manifest_usage.py::csql_keys`
and `CSQL_FAMILIES` already record `csql-unit:<unit>` and `csql-metadata:<name>` (read by part 06
§6), so no pull request adds a key family, and part 06's flips (pull request 10) hold the uses.

---

## 6. CI cost and the stack's order

### 6.1 The rows (`proof/README.md`, "Timings and what the lane is expected to take")

| The change | Groups | Shards | Expected end |
|---|---|---|---|
| nothing the lane reads | the audit sample | 1 | about 6 min |
| a harness file no document's key names (`proof/native`) | 34 | 3 | 8.7 min |
| a judge's file (`proof/checks/**`, a register, walk stops, the surface) | all, judged from stored records | 6 | 10.2 min |
| the observation's code, the image, or most documents | all, observed afresh | 14 | 12.9 min (measured once: 12 min 40 s) |

Two facts decide the stack: a pull request's store restore reads main's newest snapshot and its
own `pr<number>` scope only (`proof/ci/store-keys.mjs`), so a stacked pull request never reads its
base's records and every pull request above the first one that moves every key observes afresh on
every run; and a push to a pull request restacks every one above it, each a new run of up to 14
shards against the account's twenty concurrent jobs.

### 6.2 What each pull request of the stack costs

Part 10 holds the stack's table with each pull request's contents. What this part owes is the cost
model: which row of §6.1 each pull request runs, and what a push costs. A pull request's row is the
row of everything between main and its head, because its store restore reads main's snapshot and
its own scope only (§6.1), so each pull request also pays for every change beneath it that main's
store does not hold.

| # | Pull request | Row | Shards | Why that row |
|---|---|---|---|---|
| 1 | Lane mechanics (§7) | 10.2 min | 6 | a judge's files (`known-defects.json`, `registers.py`, `manifest_value_classes.py`, `controls.py`) and `proof/native`, with two new documents and their controls observed; no existing document's key moves, so every other record is judged from main's store |
| 2 | Cutover skeleton (part 09) | 10.2 min | 6 | no lane input of its own (`scripts/` only), but pull request 1's documents, controls and entries are not in main's store, so they are observed and every record judged again |
| 3 | Projection | 10.2 min | 6 | the same: served tool schemas are no lane input, and pull request 1's records are not in main's store |
| 4 | Wire tree for the record family and the scaffolding | 12.9 min | 14 | moves most documents' bytes (part 04 §5.1, §5.2): the first fresh lane |
| 5 | Shape | 12.9 min | 14 | moves every key (`document.json` is an input of `a`); every observation change of this part rides it (§4.1, §4.4, §2.4, the stops, the walk model of §3.3) |
| 6 to 15 | Checker, Preview, Lowering, Instances and session, CSQL, Builder, Authoring, Cutover, Contracts and public docs, Removal | 12.9 min each | 14 each | whatever each changes, its base's fresh records are not in main's store, so every key is observed afresh on every push |

Placing the wire tree at 4, below the shape, costs no extra fresh lane: either order has twelve
12.9-minute pull requests, and this order keeps the emitter restructure reviewed apart from the
stored shape (part 04 §8).

**What a push costs.** A push to pull request k restacks k+1 to 15, so it starts 16 − k lane runs.
Rows 1 to 3 are 6 shards each and rows 4 to 15 are 14, so the shard-jobs a push starts are
6 · max(0, 4 − k) + 14 · (16 − max(k, 4)):

| Push to | Lanes | Shard-jobs | Rounds of twenty |
|---|---|---|---|
| 1, lane mechanics (or cutting the whole stack) | 15 | 18 + 168 = 186 | 10 |
| 2, cutover skeleton | 14 | 12 + 168 = 180 | 9 |
| 3, projection | 13 | 6 + 168 = 174 | 9 |
| 4, wire tree | 12 | 168 | 9 |
| 5, shape | 11 | 154 | 8 |
| 8, lowering | 8 | 112 | 6 |
| 10, CSQL | 6 | 84 | 5 |
| 13, cutover | 3 | 42 | 3 |
| 15, removal | 1 | 14 | 1 |

GitHub's free plan runs about twenty jobs at once across the account, and every run also holds
slots for its own emit, gate, test, smoke and build jobs (the test, smoke and build jobs for their
first three to four minutes, `proof/README.md`, "Timings and what the lane is expected to take").
So a push to pull request 1 is at least ten rounds of twenty shard-jobs, each round about one
shard's span, most of a 12.9-minute lane: on this model, about two hours of the account's whole
capacity before the top pull request's verdict, against 12.9 minutes for one lane. While a
scheduled lane holds fourteen runners, six remain, and the same push is 31 rounds (`proof/CLAUDE.md`,
"Three lanes": fourteen at once is one lane's bound, so six are left to pull requests). These are
the model's numbers, not a measurement. So:

- Pull request 5, the shape, and pull request 4, the wire tree, are settled before the stack is
  cut: their base-and-head emissions, their slices without readers, and R5 (§6.4) run on their
  branches alone, where a push costs one lane.
- A fix-up goes to the pull request it belongs in, with the pushes of a session batched into one,
  because each push below the top costs a fresh lane of every pull request above it. Pull request
  1's fix-ups are worth batching most: it sits under every other, and a push to it is the whole
  table's 186 shard-jobs.
- Pull request 10's `proof_fresh` dispatch for sensitivity is one more fresh lane on GitHub's
  runners (about 13 minutes, readers changing nothing); it is made once, after its last emission
  change.
- The reader dispatches of R1 to R4 (§6.4) run on scratch branches cut from `main`, outside the
  stack, so they restack nothing.

### 6.3 Runs while each pull request is written (local, one container, one or two workers)

As step 2's table (step 2 plan part 09, "The lane's cost, and the runs that prove each kind of fix"):

| Kind | Run |
|---|---|
| a model change or a validator narrowing | no Docker: `node --conditions=react-server --import ./proof/corpus/entropy.mts --import tsx proof/corpus/emit.ts --out <dir> --jobs 2` at base and head; the stop, the census, `index.json`'s ids, the finding multiset |
| a register move | `PROOF_READERS=0 npm run proof -- proof/checks/test_registers.py proof/lane/test_gate.py proof/checks/test_controls.py`, then `PROOF_CORPUS=<dir> PROOF_READERS=0 npm run proof -- --workers 1 proof/checks -k "targeted-datetime-ordering or targeted-datetime-operands or targeted-datetime-equality"` and `python3 -m proof.lane.gate .proof/out --documents targeted-datetime-ordering,targeted-datetime-operands,targeted-datetime-equality` |
| a targeted document | the same slice with its id; `npx vitest run proof/targeted/__tests__/targeted.test.ts` |
| the native family | `PROOF_READERS=0 npm run proof -- proof/native/test_core_runtime.py` (this runs every producer and the whole Core suite, `NativeSession.core`; minutes on one worker) |
| `casedata.py` | `PROOF_READERS=0 npm run proof -- proof/checks/test_proof3_behavior.py -k case_database` |

Docker Desktop's VirtioFS can serve a stale bind-mounted file: copy sources fresh per run or drop
the VM cache (`docker run --rm --privileged alpine:3 sh -c "sync; echo 3 > /proc/sys/vm/drop_caches"`).

The no-Docker emission is the only run of this table that belongs on the person's machine without
asking (`--jobs 2`). Every row that starts the pinned image is a lane slice; where the machine must
stay unloaded, the same slice runs on GitHub's runners as the pull request lane
(`gh workflow run ci.yml --ref <branch>`), as planning ran its own.

### 6.4 Reader runs

No served reader runs on the person's machine, and no pull request needs one before the merge
(part 10, "House rules for the stack"). The zero-load route is a dispatch on GitHub's runners,
which the person approved: `gh workflow run proof-audit.yml --ref <branch> -f nightly=false -f
mechanics=<ids>`, every reader, two shards unless `-f mechanics_shards=auto`. A selection needs one
edited document; `navigation-conditions` is the cheapest edited one with every reader (4.3
box-seconds).

**The scratch branches.** Each is cut from `main` and never merged; R3 and R4 share one:

| Run | Scratch branch (from `main`) | `mechanics` | What it settles |
|---|---|---|---|
| R1 | `proof/plan-step3-operands`: §7's two documents with their controls retained, finding 56's five entries, finding 75's two, the type reader, `OPEN_DEFECTS` `75: 3`; its last commit (`1a6ccfa9`) brings `targeted-datetime-equality` to the plan's document ("Log visit" through a Hidden Value, "Opened visits" in an advanced Search input, no third entry, no predicted stop) | `targeted-datetime-operands,targeted-datetime-equality,targeted-datetime-ordering,navigation-conditions` | every served reader's pre-fix values on both documents and where each walk ends; whether HQ's search error for "Opened visits" ends a served walk (part 06 §3.13). Settled without readers: the entries and values §7 pins |
| R2 | `proof/plan-step3-spellings`: a scratch document `targeted-expression-spellings`, never merged, holding today's admissible text for step 3's form spellings: `../q` and `.` in a repeat, `current()/..`, `/data/` reads, a casedb projection, and Hidden Values whose calculate is the planning lowering's text (the guarded `instantDays` parse, 1.6 to 3.7 KB) | `targeted-expression-spellings,navigation-conditions` | Formplayer's, Web Apps' and Android's evaluation of the lowering in UTC. Settled without readers: proof 4 over two Vellum saves and the bar. Part 04 ships `instantMicros` (part 04 §3.1: the same structure, 1.4 % larger, 1.7 to 8.8 KB); R2's structural answers carry over to it, and the shipping bytes are held by pull request 8's own lane (proof 4 and the bar run without the served readers) and its reader dispatch (part 04 §6). No second R2 over `instantMicros` is made: R2 showed no editor or bar difference without readers and no served difference with them (run 39064333759), and a reader difference on the shipping bytes is pull request 8's to answer through its own reader dispatch, which carries `instantMicros` |
| R3 | `proof/plan-step3-defaults-catalog` (with R4): the select-default map of §3.3 and the six stops' removal | the 26 documents of the dispatch list below | finding 72's five stops gone, and what each walk reaches once the form opens |
| R4 | the same branch: `entryWriter.ts` writing `catalog` from `materializableCaseTypes` and `casedata.py` reading it (§4.4) | the same 26 | finding 73's stop gone and the walk's rest; the three `int` documents and the 11 fuzz documents show nothing new |
| R5 (at pull request 5, the shape) | its branch | the eight `fuzz-expression-20260930-*`, `targeted-expression-renames`, `targeted-session-reads`, `targeted-list-first-places`, `fuzz-suite-20260930-5`, `fuzz-suite-20260930-8` and `fuzz-xform-20260930-0`, `-3`, `-4`, `-9` | the new generator's stops and findings; every served reader's values and walks on the three targeted documents; defect 21's two entries of §3.3 held on `targeted-list-first-places`, on its control and on `fuzz-suite-20260930-8`; and, with the walk model fixed (§3.3), the five documents of its gap with every reader, Android, Connect and the B and B-edit states among them, which run 39064336028 did not reach on them, and whether `fuzz-xform-20260930-0`'s module 1 form opens on any reader; all before the stack is cut |

**The first dispatches with every reader.** R1 run 39058712962, R2 run 39058666752, R3 and R4 run
39058667355, all started 2026-10-17 18:34 UTC. Each died in the job "Android reader runtime
(mechanics)", whose own suite of commcare-android predicates ran 49 tests and failed with
`failures=3, errors=5` (`test_a_newer_export_updates_the_installed_app_and_an_equal_one_does_not`,
`test_an_image_question_with_the_face_appearance_is_drawn_by_androids_face_capture_widget` and a
document widget among them). Main's own nightly has failed in the same job the same way since
2026-10-14 (issue 768), so it is no effect of the scratch branches. R3 and R4's run never reached a
shard.

**The runs without readers.** R1 and R2 were then run as mechanics runs without readers
(`PROOF_READERS=0`, the pull request lane's profile, whose gate leaves the served readers' entries
and stops to the run with them), and R3 and R4's branch was read on the host:

| Run | Without readers | What it showed |
|---|---|---|
| R1 | run 39061011794 | both documents admitted, emitted and their controls retained; every one of the branch's eight entries naming the four documents held on document and control; the one failure, `targeted-datetime-operands`'s manifest classes, which §7 registers; `csql@A` compiled all three equality queries; `targeted-datetime-equality`'s proof 4 (HQ's search `auto_launch` after a save) and sensitivity (the `sync_cases_on_form_entry` claim post) differences failed no check; all 30 of the branch's stops were left to the run with readers. That run held the scratch branch's version of `targeted-datetime-equality`, with a date-and-time question in "Log visit" and a third entry on a `date_opened` case list, `d75-date-opened-equality-case-list`. The plan's document has neither: "Log visit" writes its date and time through a Hidden Value and "Opened visits" is an advanced Search input. It first runs in R1's second dispatch, run 39064331941, on the shard whose verdict is outstanding, so the third entry is not registered and the absence of a finding 74 stop is predicted, not observed (§3.2, §7) |
| R2 | runs 39060796573 and 39061476968 | the first failed only its scratch document's own expectation `stamp-clock-local` (Core raised `XPathTypeMismatchException`: the request opened a registration form without its new-case datum `case_id_new_visit_0`); the second, with the request corrected, was clean: bar, intent, proof 4's two Vellum saves of every spelling and the lowering's text, every check. Vellum's save writes one space after each comma and either side of each binary operator and leaves the structure, which is the canonical print (part 01 §2.5). With every reader, run 39064333759 held (below) |
| R3, R4 | none; the host emission only | §3.3 and §4.4: 16 fuzz documents' bytes move under the default map, 40 select defaults in 19 documents of which 20 in 12 are none of their options, 15 of 371 case databases change with `materializableCaseTypes`, `walk-stops.json` 29 to 23, and the dispatch list of 26 documents (the 21 fuzz documents the map or `saved_prop` moves, the four expander documents of §4.4 and `navigation-conditions`) |

The register entries §7 pins are `intent` and `manifest` entries, which the pull request lane holds
without a reader, so they are settled; the walk stops are a served reader's.

**The second dispatches with every reader.** Planning wrote the fix for issue 768 (commit
`ee852ae9`, "proof: the Android reader's own checks run on the runner's standard library again"),
and each branch was dispatched again with the same `mechanics` list and that commit beneath its
scratch change: R1 run 39064331941, R2 run 39064333759, R3 and R4 run 39064336028. The Android
reader runtime job passes in all three. The fix is #771, stacked on this plan's pull request and
merged with it.

- **R2, run 39064333759: held with every reader.** It ran in the readers profile
  (`PROOF_READERS=all`: Formplayer, the Web Apps client and an Android device beside HQ and Core)
  over `targeted-expression-spellings` and `navigation-conditions`, each document's minimum and
  maximum configurations observed in pieces across two shards (`targeted-expression-spellings`
  about 1,070 worker-seconds a configuration with every reader). Every job passed, and the gate
  held each section: every block ran exactly once, all 303 items passed, every difference held to
  the register (no entry names either document, so no check reported a difference), every walk
  reached its end (neither document holds a stop), and the surface equals the committed one. So
  Formplayer's walk, the Web Apps client's replay and the device read R2's spellings (`../q` and
  `.` in a repeat, `current()/..`, `/data/` reads, a casedb projection) and the lowering's text in
  UTC as Core does on both paths, and proof 4's served saves keep them. What R2 settles for
  `instantMicros` is what the row above says.
- **R1, run 39064331941: its first shard held.** On `targeted-datetime-operands` and its control,
  the intent check shows exactly the differences of finding 56's three `intent` entries, on document
  and control. The only unregistered differences are the manifest classes pull request 1 registers
  or decides (§7): `refused/time-operand` and `undecided/time-operand` in the `suite.xml` of
  `local.ccz`, `local-again.ccz` and `local-empty-list-text.ccz`. Every served reader reproduces
  finding 56's literal case-list half: "Seen before eleven" lists nothing on Formplayer, on the Web
  Apps client in all three of its windows and on Android, where Nova's meaning lists two visits of
  the lane's case data; Formplayer reproduces its `now()` half too. The property-against-property
  half is right on the lane's derived case data, so only Core's intent check, over the document's
  fixed restore, shows it. Every walk ends submitted or at an empty list, with no stop, and the
  stop of `targeted-datetime-ordering`'s control (Formplayer, `submit-refused:validation-error` on
  the "Visit instants" form, finding 74) holds. Proof 3 compares the readers with each other, and
  all are wrong alike, so no register entry holds the readers' symptom; the `intent` entries hold
  the finding, and the readers add coverage, not a gap. **Outstanding:** the run's second shard
  lost its hosted runner (no log, no artifact, no gate failure), so `targeted-datetime-equality`
  (its first run as the plan writes it, whether its differences are exactly the two entries pull
  request 1 registers, its served pre-fix values, where its walks end, and whether a served walk
  of "Opened visits" meets HQ's search error before pull request 10), the
  `targeted-datetime-ordering` document and `navigation-conditions` await the second attempt of the
  failed jobs.
- **R3 and R4, run 39064336028: held but for two things pull request 5 carries.** The Android
  reader runtime job passed (49 tests, OK), and no job failed on infrastructure. With the six stops
  removed, no opened form reaches a reader's own end (§3.3): `fuzz-suite-20260930-8`,
  `fuzz-xform-20260930-1`, `-7` and finding 73's document run clean on Formplayer, the Web Apps
  client and Android, and the stopped forms of `fuzz-suite-20260930-5` and `fuzz-xform-20260930-0`
  open and submit on Formplayer. The three `int` expander documents pass (11 of 11 items), and 7 of
  the 11 fuzz documents whose case data changed pass (§4.4). The two things: on five documents the
  Web Apps client's submission differs from Formplayer's walk, a gap in the walk's model that pull
  request 5 fixes in `proof/formplayer/walk.py`; and on `fuzz-suite-20260930-8` proof 4 shows 24
  differences on the B and B-edit states, a knock-on of defect 21 that pull request 5 registers in
  two live entries on a new targeted document (both in §3.3). Not in hand: Android, Connect and the
  B and B-edit states on the five documents of the walk's gap, and whether
  `fuzz-xform-20260930-0`'s module 1 form opens on any reader; R5 reads them after the walk fix.

What a run shows is written into the pull request that carries its change: a reader's end past an
opened form becomes a walk stop in pull request 5, a served difference on a new document an entry
in pull request 1, a known defect's symptom on a form a removed stop opens an entry under that
defect in pull request 5, a gap in the harness's own model of a reader a fix to the harness, a new
defect a finding. R5 runs at pull request 5's branch, over the documents its row names. No reader run is required before the merge; the first night after it runs every reader
over every document either way.

**After the merge.** The merge moves every key, so the next night is the whole lane with every
reader: about 13.5 hours on up to fourteen of the twenty runners, from 03:23 UTC Tuesday to
Saturday (a merge from Saturday evening to Monday is read by Tuesday's night). It is the first run
that holds every document and control with every reader at step 3's exit, and its failures open an
issue with each group's rerun line. A merge early in the week gets that verdict soonest.

---

## 7. Pull request 1, the lane mechanics

It changes nothing Nova emits and moves no existing document's key. Its only file under `lib` is
the test table `lib/commcare/__tests__/instantOrderingTable.ts`. The cutover's pre-step half (frozen
fixtures, frozen printer, normalizer, base emitter) is not here: it is pull request 2, the cutover
skeleton (part 09 §3). Every entry below is the one the executed run held (R1 without readers, run
39061011794, over the documents and register entries of the scratch branch
`proof/plan-step3-operands`): its register section held every one of the eight live entries naming
the four documents, on document and control, and its one failure is the manifest classes item 5
registers.

1. **The zoned harness and the `expression` family's control half** (§2.1, §2.2): `families.py`
   (`ZONES`, `DEVICE_ZONES`, and `ZONED_CLASSES` with `InstantOrderingRuntimeTest` alone),
   `native-proof.init.gradle`, `core_suite.py`, `session.py`, `test_core_runtime.py`,
   `emit-expression-evidence.ts` (the table, no lowering yet), `instantOrderingTable.ts`,
   `InstantOrderingRuntimeTest.java` (the control half), README "Native proofs".
2. **`targeted-datetime-operands`** (§4.5), built with today's model (its record filters with
   `lib/domain/predicate` constructors, its form text through `docHelpers.ts::f`), as R1 ran it:
   "Visits" with "Book" and "Check", whose Hidden Value `now_order` is
   `if(#form/seen < now(), 'seen before now', 'seen not before now')` over a Hidden Value copying
   `#visit/seen`; "Seen before eleven", whose case list filter is
   `lt(prop(visit, seen), term(datetimeLiteral("2026-03-01T11:00:00")))`; and "Seen before due",
   whose filter is `lt(prop(visit, seen), prop(visit, due))`. The literal row is the case list
   filter, because form logic already refuses a date and time written as text in an ordering
   (`XPATH_TIME_ORDERING`). Pull request 5, the shape, moves it to the union with no change of
   meaning, and it stays admitted there (each ordering is a datetime against a datetime or a
   datetime literal at second precision, which `datetime-literal-precision`, from pull request 6,
   the checker, admits).
3. **Its control, retained before any fix**, from the corpus emitted on the host at this pull
   request's head: `python3 -m proof.checks.controls <corpus> targeted-datetime-operands intent manifest`
   (the manifest check reads its archives, so the control keeps them, `controls.py::ARCHIVE_READERS`,
   and its derived case types, item 6).
4. **Its three `intent` entries** under defect 56, part "datetime ordering", kind `changed`, document
   and control `targeted-datetime-operands`, each pinned to the values the run showed on both:

   | Entry | Artifact | Path | Values (before → after) | Differences it held |
   |---|---|---|---|---|
   | `d56-datetime-ordering-clock` | `evaluate:seen-before-now-*` | `/values/*/value` | `seen before now` → `seen not before now` | `evaluate:seen-before-now-a@A` and `evaluate:seen-before-now-local@local`, at `/values/0/value` |
   | `d56-datetime-ordering-literal` | `evaluate:listed-before-literal-*` | `/caseList/rows/*/caseId` | `targeted-visit-amina` → `{"absent": "Core's result holds nothing at this pointer."}` | `evaluate:listed-before-literal-local@local`, at `/caseList/rows/0/caseId` |
   | `d56-datetime-ordering-case-list` | `evaluate:listed-before-due-*` | `/caseList/rows/*/caseId` | the same | `evaluate:listed-before-due-local@local`, at `/caseList/rows/0/caseId` |

   The case lists are read from `local` only (a case-list expectation runs on the local archive);
   the clock row from `local` and `A`.
5. **Its two `manifest` entries** under defect 56, part "datetime ordering", kind `refused`, artifact
   `local*.ccz/suite.xml`, document and control `targeted-datetime-operands`, no `values` (a pin is
   only for an `intent` value):

   | Entry | Path |
   |---|---|
   | `d56-datetime-ordering-suite-cmp-time-operand` | `/xpath-expr:XPathCmpExpr/refused/time-operand` |
   | `d56-datetime-ordering-suite-lt-time-operand` | `/xpath-token:LT/refused/time-operand` |

   What the run showed: 12 differences in 12 classes, on each of `local.ccz`, `local-again.ccz` and
   `local-empty-list-text.ccz`'s `suite.xml`, under both keys (`xpath-expr:XPathCmpExpr`,
   `xpath-token:LT`) of the REFUSED entry
   `expressions-and-data/or-with-a-time-on-either-side-a-time-answer-property-or-string`: the class
   `refused/time-operand` at `/suite/entry[3]/session[1]/datum[1]/@nodeset` ("Seen before eleven",
   whose literal holds `:`) and `undecided/time-operand` at `/suite/entry[4]/session[1]/datum[1]/@nodeset`
   ("Seen before due", two custom properties `_time_kind` reads as `None`, §5.2). An undecided use
   cannot be registered (`proof/checks/registers.py`), so item 6's reader decides it: with the
   properties' type `datetime`, entry 4's uses become `refused/time-operand` too, and the two entries
   hold all six refused classes (three archives, two keys, two uses each). The `XPathCmpExpr` entry
   shares its check, path and archives with the fixed `d6-core-suite-xpath-expr-xpathcmpexpr-time-operand`
   (artifact `*.ccz/suite.xml`, control `targeted-search-hq-compile`), as eight live entries of the
   base already share a class with a fixed one; the run's register notes such pairs, and the
   document the live entry names tells them apart. There is no fixed suite `LT` entry. R1's dispatch
   with every reader showed these classes and no other unregistered difference on the document
   (run 39064331941, §6.4).
   These classes are finding 56's symptom in the manifest's words: Core reads a datetime held as
   text as NaN in an ordering (`FunctionUtils.toNumeric`), so pull request 8's lowering, whose sides
   are arithmetic, takes them off the document (§3.1).
6. **The case-property type reader** (§5.2) and what it reads. `proof/checks/controls.py::derived`
   gains `caseTypes`, `{ <case type>: { <property>: <data type> } }`, read from `document.json`: at
   this pull request each declared property's `data_type` in `doc.caseTypes` (no type is derived in
   Python), and from pull request 5 the `catalog` of §4.4, which moves every key anyway.
   `proof/checks/corpus.py` admits it as an optional derived key beside `DERIVED_KEYS` (today
   `_derived` requires exactly those four, so a retained control without `caseTypes` would be a
   layout error), and `Document.derived("caseTypes")` is None for a control retained before this pull
   request, where the reader answers `None`, today's verdict. It is optional, not one more required
   key, because a fixed control is never retained again, so none of the 105 gains it.
   `manifest_usage.py::manifest_differences` hands the document's case types to the `Runtime`
   documents it builds, and `manifest_value_classes.py::_time_kind` reads them as §5.2 states. Its
   pairs go in `test_manifest_value_classes.py`; `test_controls.py` gains a control with and one
   without `caseTypes`.
7. **Part 06's `targeted-datetime-equality`** (`proof/targeted/documents/datetimeEquality.ts`, §4.5,
   part 06 §3.13), built with today's model and admitted at every pull request of the stack. "Log
   visit" writes `seen` through a Hidden Value `seen_at` with `now()`, not a date-and-time question,
   so finding 74's stop never meets it; and "Opened visits" holds its `date_opened` equality in an
   advanced Search input's predicate, which no device evaluates, not in a case list filter, so it
   carries no `intent` expectation. Its control is retained before any fix
   (`python3 -m proof.checks.controls <corpus> targeted-datetime-equality intent`). Its two live
   entries under defect 75, part "datetime equality", check `intent`, path
   `/caseList/rows/*/caseId`, kind `changed`, document and control `targeted-datetime-equality`:

   | Entry | Artifact | Values | Differences it held |
   |---|---|---|---|
   | `d75-datetime-equality-case-list` | `evaluate:equal-visits-listed-*` | `targeted-visit-amina` → `{"absent": "Core's result holds nothing at this pointer."}` | `evaluate:equal-visits-listed-local@local` at `/caseList/rows/0/caseId` |
   | `d75-datetime-inequality-case-list` | `evaluate:other-visits-listed-*` | none: its two differences carry different values, which one pin cannot name | `evaluate:other-visits-listed-local@local` at `/caseList/rows/0/caseId` (`targeted-visit-baraka` → `targeted-visit-amina`) and `/caseList/rows/1/caseId` (`targeted-visit-chidi` → `targeted-visit-baraka`) |

   `OPEN_DEFECTS` gains `75: 3`. `walk-stops.json` gains nothing: "Log visit" asks no date-and-time
   question (§3.2). The manifest check finds no difference on this document (equality is no
   relational comparison).
8. **Docs**: `harness-findings.md` finding 56's *Documents* gains `targeted-datetime-operands`, and
   finding 75 is added under "Found while planning step 3" in the form of finding 74 (part 06
   §3.13); README "The defect rows" names both documents and gives finding 75 its row; README
   "Targeted documents".
9. **`proof/timings.json`**: groups for the two new documents and controls in the `no-readers`
   profile, from this pull request's own lane on GitHub's runners (R1's run measured each
   document's configurations at 10 to 44 worker-seconds); the `readers` profile's from the first
   run with every reader.

Its own checks: the slice of §6.3 with the gate told the three datetime documents;
`proof/checks/test_registers.py`, `test_controls.py`, `test_manifest_value_classes.py`;
`test_core_runtime.py`; and its pull request lane.

---

## Files

- Pull request 1, lane mechanics: `proof/native/families.py`, `proof/native/core/native-proof.init.gradle`,
  `proof/native/core_suite.py`, `proof/native/session.py`, `proof/native/test_core_runtime.py`,
  `proof/native/producers/emit-expression-evidence.ts`, `lib/commcare/__tests__/instantOrderingTable.ts`,
  `proof/native/core/InstantOrderingRuntimeTest.java`, `proof/targeted/documents/datetimeOperands.ts`,
  `datetimeEquality.ts` (part 06's), `proof/targeted/index.ts`, `proof/controls/targeted-datetime-operands/`,
  `proof/controls/targeted-datetime-equality/`, `proof/known-defects.json` (seven entries),
  `proof/checks/registers.py` (`75: 3`), `proof/checks/manifest_value_classes.py` (`_time_kind`'s
  type reader), `proof/checks/manifest_usage.py` (handing the case types to the suite documents),
  `proof/checks/controls.py` and `proof/checks/corpus.py` (the optional derived `caseTypes`),
  `proof/checks/test_manifest_value_classes.py`, `proof/checks/test_controls.py`,
  `proof/timings.json`, `proof/README.md`, `docs/research/2026-09-26-hq-round-trip/harness-findings.md`.
  No `walk-stops.json` change.
- Pull request 4, the wire tree: `proof/native/test_search_emission.py` (it asserts one unread
  collection-instance declaration, `remote-multiple`'s selected cases, which pull request 4 stops
  writing; the recorded difference leaves), beside part 04's `test_hq_interpolation.py`; and the
  lane files that read the on-device emitters it deletes (§2.4):
  `proof/native/producers/emit-predicate-evidence.ts` (its emit call),
  `emit-arithmetic-evidence.ts`, `emit-lookup-evidence.ts` (its `sourceHashes` paths) and
  `proof/corpus/footprint.ts` (its instance collection).
- Pull request 5, shape: `lib/__tests__/docHelpers.ts`, `lib/commcare/__tests__/xformDocArbitrary.ts`,
  `suiteDocArbitrary.ts`, `expressionDocArbitrary.ts` (new), `expander.test.ts`, `hqJsonOracle.test.ts`
  and the fixture modules of §4.1, `proof/corpus/editKinds.ts`, `documents.ts` (`FUZZ_GENERATORS`),
  `defaults.ts`, `fuzzSample.ts`, `entryWriter.ts` (`catalog` from `materializableCaseTypes`),
  `proof/corpus/__tests__/fuzzSample.test.ts` and `expressionSample.test.ts` (new),
  `proof/observe/casedata.py`, `proof/checks/controls.py` (`caseTypes` read from `catalog`),
  `proof/checks/test_proof3_behavior.py`, `proof/native/producers/emit-predicate-evidence.ts`
  (the union's builders), `emit-xpath-evidence.ts`, `lib/commcare/xpath/__tests__/nativeXPathCorpus.ts`,
  the session-read scenarios of §2.6 (`proof/native/core/FormLinkRuntimeTest.java`,
  `NestedMenuRuntimeTest.java`, `TileGroupingRuntimeTest.java` and their producers
  `emit-form-link-evidence.ts`, `emit-nested-menu-evidence.ts`, `emit-tile-evidence.ts`),
  `proof/targeted/documents/expressionRenames.ts` and `sessionReads.ts` (the five `DatumRef`
  reads and their edit), `proof/targeted/documents/searchApps.ts` (`listFirstPlaces()`, new),
  `proof/targeted/index.ts`, `proof/controls/targeted-list-first-places/` (new),
  `proof/known-defects.json` (defect 21's two entries), `proof/formplayer/walk.py` (`_fill` and
  `_reconcile`: no value sent that the question already holds) and `proof/formplayer/test_walk.py`,
  `proof/timings.json` (the new document and control), `proof/walk-stops.json` (six entries
  removed, 29 to 23), `proof/rules/conftest.py::DOCUMENTS` (only if a rule's reader test needs a
  new document).
- Pull request 7, Preview: `proof/native/core/CoreDateParityRuntimeTest.java` and its rows in
  `families.py` and the producer (part 07 §2.4).
- Pull request 8, lowering: `proof/fixed-defects.json`, `proof/known-defects.json` (56's seven and
  75's two moved), `proof/checks/registers.py` (`OPEN_DEFECTS` loses 56 and 75),
  `proof/checks/test_registers.py`, `InstantOrderingRuntimeTest.java` and
  `emit-expression-evidence.ts` (the lowered half), `datetimeOrdering.ts` (header comment), README
  "The defect rows", `harness-findings.md`.
- Pull request 9, instances and session, and pull request 10, CSQL: their targeted documents
  (pull request 9 adds `instanceReads.ts`, `inlineSearchReads.ts`, `textReads.ts` and the batch
  form of `sessionReads.ts`; pull request 10 adds `csqlComposition.ts`, its chosen-case search
  among its constructs), family extensions (pull request 9: `LookupRuntimeTest.java`,
  `LocationOwnerRuntimeTest.java`, `SearchRuntimeTest.java` and their producers, §2.6; pull
  request 10: §2.5), surface entries and inventory rows (§5.1),
  `manifest_value_classes.py::hierarchical_locations` and its pair (§5.2, pull request 9);
  pull request 10's `csql` family with its `datetime-equality` scenario and
  `CsqlCompositionRuntimeTest`'s zones, and `harness-findings.md` finding 75 recorded fixed.
- Pull request 14, contracts and public docs: no public docs page of this part's (each `content/docs`
  row lands with its behavior, part 10); `proof/timings.json` (both profiles: `no-readers` from a
  fresh dispatch, `readers` from the first night, in a pull request after it), README tables that
  count documents, controls and groups.

## Departures

- **No control for findings 72 and 73** (§3.3). A control costs a group in every lane for good, and
  neither finding is an emission a control keeps showing: each is a reader's answer to a shape any
  app can hold, held instead at its validator's boundary.
- **Defect 17 has no register entry and no pre-fix control** (§3.4): no lane check observes a
  stranded reference without a new observation over D′, which would move every key for one defect.
  Its lane witness lands with the fix; its contract is held at the commit gate.
- **The `expression` family's control half is Core's bare behaviour asserted per zone,** a native
  control in place of a retained directory, because the family builds no app (§2.2).

## Executed during planning

- **The native lowering run** (Core's own Gradle test build at the pin, offline in the pinned
  image, with an init script registering one `Test` task per run and a probe class
  `InstantOrderingProbeTest`): the mechanism of §2.1 (`systemProperty('user.timezone')`,
  `environment('TZ')` and `JAVA_TOOL_OPTIONS` reach the test JVM, `GRADLE_OPTS` does not), each
  run's JVM zone, provider and `DateUtils.timezone()`, the JUnit timings of the ten test JVMs (3.4
  to 3.7 s each), and the comparison of every run's rows (145 identical in every run, 14 varying,
  among them the `double(coalesce)` DST row false only in New York) (§2.1, §2.2).
- **A read-only probe of the effective catalog**, run from the repo root with
  `npx tsx --conditions=react-server` over the 371 documents emitted at `main` (no network, no
  Docker, no repo file changed; `git status` clean after). It compares each declared property's
  `data_type` (what `casedata.py::_type_values` reads) with
  `lib/domain/effectiveCaseTypes.ts::effectiveCaseTypes`'s: 4 documents move, `text->int` 3 and
  `text->date` 2 (§4.4).
- **A shape scan of the corpus** over the 371 documents emitted at `main`: the relative reads,
  `casedb` queries, `..` reads and fuzz references of §1.
- A read-only Python pass over `lib/commcare/surface/entries/*.json` against
  `proof/checks/manifest_value_classes.py::VALUE_CLASSES`, listing every REFUSED entry with a value
  class on an expression-related key and whether a reader exists (§5.2); and a read of
  `proof/checks/manifest_usage.py::_standing_plan`, `_evaluate`, `Entry.refused_by_hq_build` and
  `_instance_uses`.
- `unzip` over the corpus's local archives for every `jr://fixture/locations` declaration: one, in
  `location-direct/local.ccz`'s `modules-0/forms-0.xml` (§5.2).
- A read of `proof/timings.json`'s two profiles: `proof/native` 15.9 box-seconds without the
  readers; `targeted-datetime-ordering` 8.5 and its control 7.4; finding 72's and 73's documents
  4.6 to 60 without the readers and 252 to 2,079 with them; fuzz documents 15.6 and 1,062 at the
  median; targeted 4.3 and 475; the cheapest edited documents with every reader
  `expander-empty-container-expansion-emits-an-empty-group-86a5cfc1-0` (3.3) and
  `navigation-conditions` (4.3).
- Read at the pins for this part: commcare-core `DateUtils.java::setTimezoneProvider`, `::timezone`,
  `EPOCH_DATE`, `::fractionalDaysSinceEpoch`; formplayer `BrowserValuesProvider.java`,
  `SetBrowserValuesAspect.java`; commcare-hq `form_processor/utils/xform.py::adjust_datetimes`.
- **Two read-only production shape scans**, on which §1, §3.1, §3.3, §3.4 and §3.6 rely: the first
  executed 2026-10-17 by the person, the second the same day by planning under the person's
  standing permission for read-only production reads, each through
  `scripts/lib/prodDb.ts::targetProdDb` in one `REPEATABLE READ, READ ONLY` transaction, closed
  labels and counts only, over every live app, with no app unreadable and no scan failure. They
  decided which lifts, refusals and blockers the cutover meets, as §3.6 states; part 04's third
  scan gave the blank tests and the system-date comparisons. No count from them enters this plan.
- **R3 and R4's scratch branch** `proof/plan-step3-defaults-catalog`, read on the host (three host
  emissions with `--jobs 2`, Python's standard library with `-I`, no Docker): every seeded case
  database at base and on the branch, 15 of 371 changing with `materializableCaseTypes`, 252 with
  `effectiveCaseTypes`, every one of the 252 through `@external_id` (changed case-type keys over
  the 252: `@external_id` 351, `saved_prop` 13, `age` 3, `start_date` and `end_date` 1 each) (§4.4),
  read with `lib/domain/effectiveCaseTypes.ts::effectiveCaseTypes` and `::materializableCaseTypes`;
  the select defaults of the corpus at base and on the branch (40 in 19 fuzz documents, 20 in 12
  none of their options at the base, 0 after the map; 11 single and 9 multiple); a byte comparison
  of every document's `local.ccz` between the base and the branch's two emissions (16 fuzz
  documents differ, the same 16 in both); the stop removal (29 entries to 23, six removed, the
  file's formatting kept); the dispatch's selection (26 documents, 21 fuzz, four expander,
  `navigation-conditions`); and run 39058667355 (the Android reader runtime job's 49 tests,
  `failures=3, errors=5`, then "Verdict and store" exiting 2, no shard run) (§3.3, §6.4).
- **R1 without readers**, run 39061011794 on `proof/plan-step3-operands`, read for §7: the register
  held the eight entries naming the four documents (`holds: false` only for the manifest item), the
  intent differences on document and control of both new documents and
  `targeted-datetime-ordering`, the 12 manifest classes on `targeted-datetime-operands`,
  `targeted-datetime-equality`'s proof 4 (110) and sensitivity (6) differences failing no check, 30
  of 30 stops left to the run with readers, and the groups' timings. Read with it at `main`:
  `proof/checks/manifest_value_classes.py::time_operand`, `::_relational`, `::_time_kind`,
  `::_time_node`, `NON_TIME_CALLS`, `SYSTEM_DATE_NAMES`; `proof/checks/registers.py` (module
  docstring: an undecided manifest use is never an entry; `values` only on a targeted document);
  the fixed `d6-core-*-time-operand` entries; `proof/checks/controls.py::derived`, `EDIT_READERS`,
  `ARCHIVE_READERS`; `proof/checks/corpus.py::DERIVED_KEYS`, `Document._derived`,
  `Document.derived`.
- **R2 without readers**, runs 39060796573 and 39061476968 on `proof/plan-step3-spellings`: the
  first run's one failure, `stamp-clock-local` (`XPathTypeMismatchException` on the missing
  `case_id_new_visit_0` datum, from the worker log), and the second run's clean verdict, with a
  comparison of the spellings before and after Vellum's saves (§6.4).
- **The first dispatches with readers**, runs 39058712962, 39058666752 and 39058667355, and main's
  nightly: every one ended in the Android reader runtime job, 49 tests with `failures=3, errors=5`;
  main's nightly since 2026-10-14 the same (issue 768) (§6.4).
- **The second dispatches with readers**, runs 39064331941, 39064333759 and 39064336028, with the
  fix for issue 768 (`ee852ae9`, written during planning) beneath each scratch change: the Android
  reader runtime job passes in all three. R2's run 39064333759 completed with success, read from its
  jobs, its gate log and its verdict file: four blocks over two documents, 303 items, no failure, no
  difference, no stop (§6.4). R3 and R4's run 39064336028, read from its jobs, its gate log and its
  pieces' records: the Android runtime job's "Ran 49 tests … OK", no infrastructure failure, the
  ten `SubmittedOtherwise` pieces on five fuzz documents and the 24 unregistered proof 4
  differences on `fuzz-suite-20260930-8` as its only failures (§3.3, §4.4). R1's
  run 39064331941, attempt 1: its first shard's gate log and verdict (§6.4); its second shard lost
  its hosted runner, with no log and no artifact, and the second attempt of the failed jobs was
  started. **Outstanding:** that second attempt's verdict.
- **Read for the run's two findings**, at `main`: `proof/formplayer/walk.py::_fill` and
  `::_reconcile`, `proof/editors/driver/steps/webapps/answer.js` (each widget's "unchanged"),
  `proof/observe/walks.py::window_of` and `::runs_for` (a phone's own run is one given a phone's
  places), `proof/webapps/observe.py::shown` (the windows each run is replayed in),
  `proof/checks/registers.py` (module docstring and loader: an entry never names a fuzz document)
  and the 34 live entries of defect 21 in `proof/known-defects.json` (§3.3).
- **A lane-mechanics observation in R1's run, unrelated to step 3**: the gate's "every block ran
  exactly once" section reported `corpus:targeted-lookup-reserved-tags` collected by both shards
  when only that document's control was queued. Observed on that run alone and not confirmed on
  `main`; no part of this plan depends on it.
- **The stack's cost model** (§6.2): arithmetic over §6.1's rows and `proof/README.md`, "Timings and
  what the lane is expected to take" (twenty jobs at once, the shards' late starts), and
  `proof/CLAUDE.md`, "Three lanes" (fourteen runners for a scheduled lane). Nothing was run for it.
- No Docker run and no served reader on the person's machine for this part; the reader runs it
  specifies run on GitHub's runners.
