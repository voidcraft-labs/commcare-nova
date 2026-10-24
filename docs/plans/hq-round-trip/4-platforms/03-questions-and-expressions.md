# Step 4, part 03: Questions and expressions

Part of [step 4's plan](../4-platforms.md), which holds the decisions, the stack and the exit.
This part covers what the platform declaration (part 01) means for one question kind and four
kinds of expression read:

- **A.** Defect 18 and finding 74's authoring half: the date-and-time question is refused where
  Web Apps is declared, and the split that replaces it (§1, §2).
- **B.** `here()` in a case list, which Web Apps never answers (§3).
- **C.** Step 3's deferred reads: Search fields read in a search-first module's forms, case list
  and detail (§4), the text a worker typed into a case list's search box (§5), the session
  context fields `drift`, `window_width` and `applanguage` (§6), and the `current()` print of a
  repeat-crossing form read inside a row predicate (§7).

The platform feature table, its two validator channels and the declaration itself are part 01's.
Preview's per-platform values are part 06's. This part names each feature row it relies on by its
`PlatformFeatureId` and says which pull request adds the rows that cannot exist before it (§11).

Citations are `path::symbol` for Nova at `main` `e9e6cd93`, and `file::symbol` for CommCare at
the pins `proof/pins.json` names: commcare-hq `d6c6e16d8ae1` (paths relative to `corehq/apps`
unless named), commcare-core `8e9ba8d908e9` (paths under `src/main/java` unless they start with
`src/cli`), formplayer `24383ac71bfb` (paths under `src/main/java/org/commcare/formplayer`),
commcare-android `7a5584475580` (paths under `app/src/org/commcare`), and Vellum `01215f251c57`,
the build HQ vendors at that pin. A citation says where a behavior lives. Where an execution
decides a fact, the text names the execution and plans both of its outcomes; "Executed during
planning" at the end lists what ran.

## Decisions in brief

1. **The date-and-time question is offered only where Web Apps is not declared.** Its use is the
   feature `datetime-question` (Web Apps unavailable, Android runs), a structural use located at
   the field (part 01). Everything that follows from that for the question is §1.3.
2. **The split is design E.** The original question keeps its UUID, id, position, `relevant` and
   `caseWrite` and becomes a Hidden Value calculated by the clock-keeping date
   `date(format-date(if(#form/<id>_date = '' or #form/<id>_time = '', '', concat(#form/<id>_date, 'T', #form/<id>_time)), '%Y-%m-%dT%H:%M:%S.%3%Z'))`.
   A date question `<id>_date` and a time question `<id>_time` are inserted immediately before
   it. No reader of the original is rewritten, and Core holds exactly what it held before: a
   `DateTimeData` of the local instant, on both platforms, writer or not (§2.1).
3. **Typing rule R2.** In form logic the checker types `date(format-date(X, '%Y-%m-%dT%H:%M:%S.%3%Z'))`
   as a date and time held as a Core `Date` (`datePattern.ts::isClockKeepingDate`), because Core
   returns a `Date` with its clock for that shape (§2.6).
4. **Bind rule R3.** A Hidden Value binds the type of the property it writes; one that writes none,
   or whose property has no effective type, binds `xsd:dateTime` when its calculate is the
   clock-keeping date (`fieldValueType.ts::fieldValueType`). Every consumer follows through that
   one function (§2.7).
5. **Conversions are representable both ways.** `datetime.convertTargets` gains `hidden`;
   `isRepresentableConversion(from, to)` admits a conversion when either kind lists the other;
   `convertField` gains an optional `label` seed, required where the destination declares a label
   the source kind lacks. Undo of every offered conversion then replays (§2.8).
6. **The media diff skips a slot the destination kind does not declare** (§2.9), and **Preview
   reads a time answer as Core does, without the `Z` storage tag** (§2.10).
7. **One planner, `lib/doc/datetimeSplit.ts`,** serves the builder gesture, the cutover and the
   fuzz mapping (the last two through `lib/doc/platformDeclaration.ts::planContentDeclaration`,
   which carries this part's `DatetimeSplit`), with identities derived under namespace
   `6cbda68f-3426-4851-8dcc-ed0424034b59` (§2.5, §2.11).
8. **`here()` in a case list is unavailable on Web Apps in every case-list context:** rows, sorts
   and the case detail. HQ's Web Apps client sends no location, so Formplayer answers Core's
   placeholder while the list is built and `''` everywhere else (§3).
9. **A Search field read is admitted in the field and Connect slots of a search-first module's own
   forms, and in that module's case list and detail columns.** Search first is itself unavailable
   on Android, so no platform check of its own is needed. Web Apps difference: a form opened from
   a link or an entry point reads the Search fields' starting values (§4).
10. **The case list's typed search text is a new value arm `{ kind: "case-list-search-text" }`,**
    Android only, admitted in form field and Connect slots of an entry with exactly one case list,
    printed `if(count(P) > 0, P[1], '')` over `P = instance('commcaresession')/session/data/stringquery`
    (§5).
11. **`drift` is an integer, always present; `applanguage` is text whose values are the app's
    language codes; `window_width` is an integer admitted only in slots CommCare evaluates while
    a menu or list loads,** refused in every slot a form evaluates, gated on one native Core run
    with both outcomes planned (§6).
12. **Absent-capable session reads print under a count guard**: `window_width`, `applanguage` and
    the case list search text. The other context fields keep their bytes (§6.3).
13. **A form read inside a secondary-instance row predicate that crosses a repeat the slot is in,
    or whose own slot it is, prints `current()/<relative>`** in every target. The Vellum shadow
    holds it only where another hashtag form read keeps the expression's shadow; otherwise the
    calculate has no shadow. Reads that cross no such repeat keep their bytes. No stored change
    (§7).
14. **Stack:** the split's groundwork in pull request 3, the question's and `here()`'s refusals in
    pull request 4, every read of §4 to §7 in pull request 10 with the builder cards and editor
    completions that make them authorable, offering by declaration in pull request 11 and the agent
    surfaces in pull request 12 (§11).

---

## 1. The date-and-time question

### 1.1 What Nova emits today

- **The kind.** `lib/domain/fields/datetime.ts::datetimeFieldSchema` holds `validate`,
  `validate_msg` and `default_value` over `inputFieldBaseSchema` (label, hint, help, media,
  `required`, `relevant`, `caseWrite`). Its metadata is `xformKind: "input"`,
  `dataType: "xsd:dateTime"`, `saDocs: "Combined date + time picker."`,
  `convertTargets: ["date", "time"]`.
- **The control and bind.** An `<input ref>` (`lib/commcare/xform/builder.ts`) bound
  `xsd:dateTime` (`lib/commcare/xform/bindType.ts::fieldBindType`).
- **Its case write.** A question with `caseWrite` whose `fieldValueType` is `datetime` gets the
  generated sibling `nova_datetime_<id>` (`lib/commcare/xform/generatedNodes.ts::planGeneratedNodes`),
  bound `xsd:string`, `relevant="count(<q>) > 0"`, calculated by
  `lib/commcare/xform/datetimeCaseValue.ts::datetimeCaseValueCalculate`
  (`instant.ts::typedInstantValue`: `if(q = '', '', format-date(coalesce(q, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))`).
  HQ's case actions name the sibling (`lib/commcare/formActions.ts::caseUpdateQuestionPath`,
  and the usercase bucket in the same file). A Hidden Value writing a date-and-time property takes
  the same sibling, because `lib/domain/fieldValueType.ts::fieldValueType` gives a Hidden Value
  its written property's type.

### 1.2 What each platform does with it

- **Web Apps has no widget.** HQ's client switches on the question's data type in
  `cloudcare/static/cloudcare/js/form_entry/entries.js::getEntry`, which has no `DATETIME` case
  (the constant exists only in `form_entry/const.js`), so the question falls to
  `UnsupportedEntry`, whose constructor answers `'Not Supported by Web Entry'`. Formplayer casts
  every answer through Core (`api/json/JsonActionUtils.java::getAnswerData`; Core
  `core/model/data/DateTimeData.java::cast`); the placeholder does not parse, so Formplayer
  answers `illegal-argument`. Where the client submits the placeholder, Formplayer refuses the
  form, which is finding 74 (`harness-findings.md`). The same client serves HQ's App Preview.
- **Android draws one.** `views/widgets/WidgetFactory.java::buildBasicWidget` maps
  `DATATYPE_DATE_TIME` to `DateTimeWidget`.

### 1.3 From step 4: refused where Web Apps is declared

The use is the feature `datetime-question` in part 01's table (Web Apps `unavailable`, Android
`runs`, entry `questions/date-and-time-xsd-datetime`), found by `platformFeatureUses` for every
field of kind `datetime` at any depth and refused as `PLATFORM_FEATURE_UNAVAILABLE`
(`details: { feature: "datetime-question", platform: "web-apps" }`) at the field. What follows
for the question:

- **The refusal's copy** is part 01's, in its three voices (part 01 §7, `datetime-question`): the
  builder's `platformBuilderSentence`, the agent and MCP's `platformRefusalMessage`, and the picker
  line `platformPickerLine`, built from the row's note, remedy and refusal copy in part 01 §4.1 and
  the row's own picker line in part 01 §2.3. This part writes no sentence of its own for it.
- **The remedy is the split.** The builder offers it as the gesture "Ask for the date and the time
  separately" on the refusal row and in the question's field actions menu
  (`splitDatetimeQuestion`), and, where Web Apps is declared, the insertion menu offers "Date and
  time (as two questions)", which adds a date-and-time question and its split in one batch
  (`addDatetimeAsTwoQuestions`; both pull request 11, part 07 §2.5, §2.6). The SA and MCP compose
  it from existing tools, taught by the workflows paragraph of part 07 §3.4 (pull request 12),
  which carries §2.2's calculate. Neither adds a server endpoint: each gesture runs §2.11's planner
  and commits one undoable batch.
- **The convert menu.** From pull request 3 a date-and-time question converts to Hidden as well
  as to Date and Time (§2.8), like a text question does today.
- **The model-facing description.** From pull request 12, `datetime.ts::datetimeFieldMetadata.saDocs`
  is part 07 §3.4's platform-neutral sentence, and the guide appends the generated
  `platformSentence` for `datetime-question` after it (part 07 §3.4).
- **The agent's pre-check.** From pull request 12, `addFields` and `editField` (SA and MCP) refuse a
  `datetime` kind in an app that declares Web Apps before the batch reaches the gate (part 07
  §3.7), with part 01's `platformRefusalMessage`, the validator's own message, so the two cannot
  drift.
- **Preview.** Preview plays Web Apps only for an app that declares it (part 06), and such an app
  holds no date-and-time question, so Preview's Web Apps mode never draws one. Its Android mode
  keeps today's picker.
- **Finding 74.** `targeted-datetime-ordering` declares Android only and keeps finding 56's
  operands; its walk stop moves to its control; `fuzz-xform-20260930-0` maps to Android only and
  its stop entry is removed, so `proof/walk-stops.json` goes from 26 entries to 25. These moves
  are part 08's, in pull request 4 (part 08 §2.2).

---

## 2. The split

### 2.1 Why the original becomes a Hidden Value

Core's readers decide the design. Each fact is read at the Core pin:

| Fact | Source |
|---|---|
| A calculate's `String` result stays `StringData` under any bind type; a `Date` becomes `DateTimeData` only under `xsd:dateTime`, `TimeData` under `xsd:time`, else `DateData` | `core/model/condition/Recalculate.java::wrapData` |
| `toDate` of text parses it with its clock and does not round; of a `Date` it rounds to the local day; of `''` it returns `''`; a failed parse throws | `xpath/expr/FunctionUtils.java::toDate`, `::expandDateSafe` |
| A date answer unpacks to its `Date`; a time answer falls through to `TimeData.uncast`, `HH:mm:ss.SSS` with no zone | `xpath/expr/XPathPathExpr.java::unpackValue`, `core/model/data/TimeData.java::uncast` |
| `format-date(<zone-less text>, '%Y-%m-%dT%H:%M:%S.%3%Z')` reads the text as local wall time in the platform's zone and prints it with that instant's offset; of `'T'` it throws | `xpath/expr/XPathFormatDateFunc.java::dateStr`, `core/model/utils/DateUtils.java::parseDateTime`, `::format` |
| A `Date` against text compares both as `toString`, so `D = ''` is a correct blank test for a date or time answer | `xpath/expr/XPathEqExpr.java::testEquality` |
| Formplayer reads the worker's zone from the browser (`tz_from_browser`); Android uses the device zone | `services/BrowserValuesProvider.java`, `aspects/SetBrowserValuesAspect.java`; Core `core/model/utils/TimezoneProvider.java` |
| A constraint sees the candidate answer as `.`, and both platforms re-check every constraint at completion | `core/model/FormDef.java::evaluateConstraint`; Android `tasks/SaveToDiskTask.java::hasInvalidAnswers`; Formplayer `application/FormSubmissionHelper.java` (`validateAnswers`) |

So only a `Date` under an `xsd:dateTime` bind reproduces what the original question held. A
calculate that returns text changes three kinds of readers of the original: `concat`, `string()`
and a label output print the whole offset text where they printed the day; arithmetic and
`number()` read `NaN` where they read the day number; and `format-date(node, p)` keeps the clock
where it rounded to midnight. The calculate is therefore `date(...)` over text with its clock,
which `toDate(String)` parses unrounded, and R3 binds the node `xsd:dateTime`.

Rejected, each for its reason:

- **A form spelling for `datetime-coerce`.** `lib/domain/expression/typeChecker.ts::admission`
  refuses the arm in form logic and `print.ts::printWith` has no spelling for it. Its only
  Core-meaningful spelling is `date(text)`, already `date-coerce`'s, so two arms would share one
  spelling and not round-trip.
- **Typing an instant-pattern `format-date` as a date and time held as text.** The node would hold
  `StringData` and string, numeric and `format-date(node)` readers of the original would change
  meaning; every stored `format-date(now(), …)` written to a text property would newly fail.
- **The research's outline design** (the date question keeps the UUID, the time and the join are
  new, every reader rewritten). Every expression, prose output, Connect slot and case operation
  reading the original would be rewritten; the case write moves to a new node, which changes HQ's
  `question_path`; the `/data/<id>` export column changes from an instant to a date.
- **No split** (a "neither" app as a cutover blocker). Authors get no one-step remedy, and the fuzz
  mapping has no total repair for a "neither" draw without restructuring navigation.

### 2.2 The stored shapes

The example is a form-root question `visit` in a module of case type `patient` writing
`patient/visit_at`. Inside a group or repeat only the printed paths change.

**`<id>_date`**: `{ uuid: D, id: suffixUntilFree("<id>_date", taken), kind: "date", label,
label_media?, hint?, help?, help_media?, required?, relevant?, default_value? }`. No `caseWrite`,
`validate` or `validate_msg`.

**`<id>_time`**: `{ uuid: T, id: suffixUntilFree("<id>_time", taken ∪ {date id}), kind: "time",
label, label_media?, hint?, help?, help_media?, required?, relevant?, default_value?, validate?,
validate_msg? }`.

`taken` is the ids of every child of the original's parent (`fieldOrder[parent]`), plus the
Connect block ids when the parent is the form root (`lib/doc/identifierVerdicts.ts`, the sibling
rule).

**Position.** `addField D` after the original's current predecessor
(`lib/doc/mutations/sequence.ts::predecessorOf`, `null` when first), then `addField T` after `D`.
The order is `…, <id>_date, <id>_time, <id>`.

**The original**: `{ uuid, id, kind: "hidden", calculate: J, relevant?, caseWrite? }`, all three
kept fields unchanged. `default_value` is cleared, because a Hidden Value holds one value source
(`fields/hidden.ts::HIDDEN_VALUE_ONE_SOURCE_SENTENCE`). The conversion drops `label`, `hint`,
`help`, both media slots, `required`, `validate` and `validate_msg`.

**The calculate J**, stored:

```json
{ "kind": "date-coerce", "value":
  { "kind": "format-date", "pattern": "%Y-%m-%dT%H:%M:%S.%3%Z", "date":
    { "kind": "if",
      "cond": { "kind": "or", "clauses": [
        { "kind": "eq", "left": { "kind": "term", "term": { "kind": "field", "uuid": "<D>" } },
                        "right": { "kind": "term", "term": { "kind": "literal", "value": "" } } },
        { "kind": "eq", "left": { "kind": "term", "term": { "kind": "field", "uuid": "<T>" } },
                        "right": { "kind": "term", "term": { "kind": "literal", "value": "" } } } ] },
      "then": { "kind": "term", "term": { "kind": "literal", "value": "" } },
      "else": { "kind": "concat", "parts": [
        { "kind": "term", "term": { "kind": "field", "uuid": "<D>" } },
        { "kind": "term", "term": { "kind": "literal", "value": "T" } },
        { "kind": "term", "term": { "kind": "field", "uuid": "<T>" } } ] } } } }
```

The field terms carry no `spelling`, so they print as hashtags; the literals carry no `data_type`,
as the parser builds them. The pattern is a plain string, which `expressionAst.ts` (`case
"format-date"`) stores for any literal that is not a preset name. `datePattern.ts` exports the
builder `clockKeepingJoin(date: Expression, time: Expression): Expression` that returns exactly
this tree; the planner, the guide's tests and the targeted document build J through it.

### 2.3 Every printed form

- **Builder text** (`print.ts::printFormExpression`):
  `date(format-date(if(#form/visit_date = '' or #form/visit_time = '', '', concat(#form/visit_date, 'T', #form/visit_time)), '%Y-%m-%dT%H:%M:%S.%3%Z'))`
- **XForm `calculate`** (`wire/fromExpression.ts`: `date-coerce` prints `date`, `format-date`
  prints `format-date`; neither blank test is lowered as an instant, since neither side is a date
  and time):
  `date(format-date(if(/data/visit_date = '' or /data/visit_time = '', '', concat(/data/visit_date, 'T', /data/visit_time)), '%Y-%m-%dT%H:%M:%S.%3%Z'))`
- **Bind**: `<bind nodeset="/data/visit" type="xsd:dateTime" calculate="…" vellum:nodeset="#form/visit" vellum:calculate="…"/>`,
  where `vellum:calculate` is the builder text above, plus `relevant` and `vellum:relevant` when
  the original had one. The real attribute and the shadow hold plain `#form/` reads, so the
  shadow is written as `lib/commcare/CLAUDE.md`, "Vellum dual-attribute pattern", writes any
  other. The exact bytes are held by the snapshot test of §9 (`datetimeSplitXform.test.ts`), the
  one execution that settles spacing.
- **Case write**, unchanged bytes: the original still has `caseWrite`, and from R3 its
  `fieldValueType` is `datetime`, so `nova_datetime_visit` is generated as today with
  `relevant="count(/data/visit) > 0"` and calculate
  `if(/data/visit = '', '', format-date(coalesce(/data/visit, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))`.
  `formActions.ts` still names it; the preload entry is still emitted and the calculate
  overwrites it, as for any Hidden Value writer.
- **Vellum keeps the typed bind.** `src/mugs/types/misc.js::DataBindOnly` declares no `dataType`,
  so `src/mugs/defaultOptions.js::getBindList` writes `type: undefined` and then copies every
  `rawBindAttributes` key whose value is undefined: the parsed `type="xsd:dateTime"` is written
  back on save. The two new questions are ordinary Date and Time mugs (`src/mugs/types/date.js`).
  HQ's two Vellum saves of each form of `targeted-datetime-split` (proof 4) hold this in pull
  request 3's own lane, which runs HQ's editors without the served readers (`proof/README.md`,
  "The lane's two profiles"); the served readers read the document in the run started by hand at
  pull request 3's head (part 08 §4.1, §6.3).

### 2.4 The moves

Each move copies the same tree or prose, keeping its identities and any `#form/` reads of other
fields.

| What | Where it goes |
|---|---|
| `label`, `label_media`, `hint`, `help`, `help_media` | copied to both new questions. Each language's entry for the original's `label`, `hint` and `help` units (`makeTranslationUnitId("field", uuid, "label" \| "hint" \| "help")`) is copied with `setTranslation` (same `entry`, review state included) to the same slot of both questions. The source prose is identical, so the source fingerprint is too. The original's own entries are pruned in the same batch by `localizationMaintenance.ts::pruneOrphanTranslationEntries`, since the Hidden Value owns no such unit |
| `relevant` | kept on the Hidden Value and copied to both questions |
| `required` | copied to both questions; a Hidden Value cannot hold one |
| `validate` V and `validate_msg` | moved to `<id>_time` as `if(#form/<id>_date = '', true(), V′)`. In V′ every read of the original's UUID (any spelling) is replaced by `date(format-date(concat(#form/<id>_date, 'T', .), '%Y-%m-%dT%H:%M:%S.%3%Z'))`, where `.` is `{ kind: "field", uuid: T, spelling: "relative" }`. Core substitutes the candidate `TimeData` for `.`, R2 types the replacement as a date and time held as a `Date`, so `instantOperand.ts::byType` classes it `typed` and its comparisons lower as today. Both platforms re-check it at completion (§2.1). The `validate_msg` unit's entries move to `<id>_time`'s `validate_msg` unit. Example for `. <= now()`: `if(#form/visit_date = '', true(), date(format-date(concat(#form/visit_date, 'T', .), '%Y-%m-%dT%H:%M:%S.%3%Z')) <= now())` |
| A case preload | where `lib/domain/casePreload.ts::writerPreloadsFromLoadedCase(original, module, form)` holds, the preload wins over a default on a device, so the defaults come from the case: `<id>_date` gets `date(#<caseType>/<property>)` (a `form-case` term), `<id>_time` gets `format-date(coalesce(#<caseType>/<property>, ''), '%H:%M:%S.%3')`. The original's `default_value`, dead before, is dropped |
| `default_value` S otherwise | `<id>_date` gets `date(S)`; `<id>_time` gets `format-date(coalesce(S, ''), '%H:%M:%S.%3')`. `coalesce` unpacks a node's `Date`, so `format-date` keeps its clock rather than rounding a node (the trick `typedInstantValue` uses); a form-logic `coalesce` of a date and time with `''` types unknown with no error (`typeChecker.ts::branchResult`). `TimeData.cast` reads `HH:MM:SS.mmm`. Neither default gets a shadow: each is constant-only or a case read |
| Prose outputs of the original elsewhere | unchanged: a `DateTimeData` output still prints the day (`FunctionUtils.java::toString`) |
| Expression readers anywhere | unchanged (§2.1) |
| A close condition naming the field | unchanged as data. Its placement can become `form-action`, since a Hidden Value is a statable kind under `lib/domain/closeCondition.ts::closeConditionPlacement`: it does where the field stands in no repeat and the answer holds no `'` and neither starts nor ends with `"`, and the HQ JSON bytes move. Otherwise it stays `save-to-case` |

A self read of the original through a step filter cannot be moved onto `.`; no admitted original
holds one, and the planner refuses it (§2.11).

### 2.5 Identities and ids

New `lib/domain/datetimeSplitIdentity.ts`:

```ts
export const DATETIME_SPLIT_NAMESPACE_UUID = "6cbda68f-3426-4851-8dcc-ed0424034b59";
export function datetimeSplitFieldUuid(
  appId: string, fieldUuid: Uuid, purpose: "date" | "time", attempt = 0,
): Uuid;
```

The name is `JSON.stringify(["nova-datetime-split-v1", appId, fieldUuid, purpose])` for attempt 0
and `JSON.stringify(["nova-datetime-split-v1", appId, fieldUuid, purpose, attempt])` after, hashed
with `uuidv5` under the namespace, the JSON-array naming `caseOperationIdentity.ts::authoredCaseIdNamespaceName`
uses. The planner takes the first attempt whose two UUIDs are both free in the document. Reason:
the identities are deterministic, so the cutover's dry-run and execute digests match and the fuzz
mapping makes no random call; two people splitting the same question at once collide on the UUID
and the second batch is refused rather than leaving four questions; and a question split, joined
back by hand while one of its questions stayed, and split again still gets free identities.

Ids come from `lib/domain/idSlug.ts::suffixUntilFree` over §2.2's `taken` set, earlier allocations
of the same batch included.

Planning computed the two identities of the corpus's one "neither" document,
`fuzz-suite-20260930-8` (app id `suite-fuzz-app`, original field `model`, uuid
`b94f283e-4f0c-5542-af5a-f1fca0afb3ae`): `model_date` `dbc29a4b-ccff-5bd7-84cd-1d9dfd69219c` and
`model_time` `4fd829ed-23d6-523f-b621-306e6c6157dd`. The identity test asserts both.

### 2.6 Typing rule R2

`lib/domain/expression/datePattern.ts` gains:

```ts
export const INSTANT_TEXT_PATTERN = "%Y-%m-%dT%H:%M:%S.%3%Z";
/** A `format-date` whose pattern is fixed to `INSTANT_TEXT_PATTERN`. */
export function isInstantText(e: Expression): boolean;
/** `date-coerce` of instant text: Core returns a `Date` with its clock. */
export function isClockKeepingDate(e: Expression): boolean;
export function clockKeepingJoin(date: Expression, time: Expression): Expression;
```

`isInstantText(e)` is `e.kind === "format-date" && fixedDatePattern(e.pattern) === INSTANT_TEXT_PATTERN`;
`isClockKeepingDate(e)` is `e.kind === "date-coerce" && isInstantText(e.value)`. Both read the
tree, never text.

`typeChecker.ts`, in the `date-coerce` / `datetime-coerce` / `double` case, returns
`scalar("datetime")` (held `"date"` by `scalarHeld`) when `ctx.ruleSet === "form" &&
isClockKeepingDate(expression)`, and today's `scalar("date")` otherwise. The record rule set keeps
its own `datetime-coerce`. Consumers that need no change, each checked:

- `instantOperand.ts::byType` already classes a `datetime` held `"date"` as `typed`, so
  comparisons with it lower through `typedInstantValue`.
- `ruleSets.ts::isWriteAssignable(datetime, datetime)` holds, so the Hidden Value writes a
  date-and-time property.
- `inference.ts::heldOf` reads the calculate's whole held class (`"date"`), and R3 makes
  `clockIsLost` false (its `dateTimeBind` is true).

`lib/commcare/xpath/wire/instant.ts` imports `INSTANT_TEXT_PATTERN` in place of its local
`TYPED_INSTANT_PATTERN` literal.

### 2.7 Bind rule R3

`lib/domain/fieldValueType.ts::fieldValueType` becomes: a visible question's kind type; a Hidden
Value writing a property with an effective type, that type; any other Hidden Value, `"datetime"`
when `isClockKeepingDate(field.calculate)` holds, else `undefined` (`xsd:string`). Reason: without
the `xsd:dateTime` bind Core wraps the `Date` as `DateData` and drops the clock
(`Recalculate.java::wrapData`). The rule reaches only the new shape; the cutover's scan counts the
stored ones (§10).

Every consumer reads it through `fieldValueType`, and each is listed with what it does for the new
shape:

| Consumer | Effect |
|---|---|
| `lib/commcare/xform/bindType.ts::fieldBindType` | binds `xsd:dateTime`; its docblock's "A Hidden Value writing a property of any other type keeps `xsd:string`" gains "or calculated by the clock-keeping date" |
| `lib/domain/expression/inference.ts` (`dateTimeBinds`) | the site's `dateTimeBind` is true: held `"date"`, not clock-lost, for writer and non-writer alike |
| `lib/preview/engine/formEngine.ts` (the computed value and `calculatedScalar`) | Preview keeps the `XPathDate` instant and writes canonical instant text, as `DateTimeData` does |
| `lib/commcare/xform/builder.ts`, `generatedNodes.ts`, `formActions.ts` | each is guarded by `caseWrite`, so only a writer gets the `nova_datetime_` sibling; a non-writer gets none, as today |

`lib/domain/CLAUDE.md`'s sentence "a Hidden Value that writes nothing keeps `xsd:string` whatever
its calculation works out to" becomes "a Hidden Value that writes nothing keeps `xsd:string`,
except one calculated by the clock-keeping date (`expression/datePattern.ts::isClockKeepingDate`),
which binds `xsd:dateTime` so Core keeps its clock".

### 2.8 Conversions

- `datetime.convertTargets` becomes `["date", "time", "hidden"]`.
- `lib/domain/fields/index.ts` gains `isRepresentableConversion(from, to)`:
  `getConvertibleTypes(from).includes(to) || getConvertibleTypes(to).includes(from)`, and
  `convertNeedsLabelSeed(source, toKind)`: `fieldKindDeclaresKey(toKind, "label") && !("label" in source)`.
- `lib/doc/mutations/fields.ts` (`case "convertField"`) and `lib/doc/mutationTargetAdmission.ts`
  (`case "convertField"`) test `isRepresentableConversion` in place of `getConvertibleTypes(…).includes`.
  The builder's convert menu keeps offering `getConvertibleTypes` only.
- `lib/doc/types.ts`: the `convertField` mutation gains `label: proseTemplateSchema.optional()`.
  Admission refuses a `convertField` whose destination declares `label` while the current kind
  does not and that carries no `label`, the `optionsSource` precedent beside it. The reducer passes
  it to `reconcileFieldForKind(field, toKind, { optionsSource, label })`, which seeds `label`
  only where the source has none.
- `lib/doc/diffDocsToMutations.ts` attaches `label: cloneEntity(nField.label)` to the convert when
  `convertNeedsLabelSeed(pField, nField.kind)` and `nField` has a label.

Reason: the split must be an ordinary `convertField`, and its undo inverse
(`lib/doc/store.ts::deltaBetween`, which is `diffDocsToMutations(after, before)`) converts the
Hidden Value back to `datetime`, which today is unrepresentable twice: `hidden.convertTargets` is
`[]`, and `reconcileFieldForKind` fails because a date-and-time question requires a label a Hidden
Value lacks. The same holds today for undoing `text` → `hidden`. The key is additive and optional,
so no fold horizon.

### 2.9 The media diff fix

`diffDocsToMutations.ts::diffFieldMedia(prev, next, uuid)` gains a fourth argument, the
destination kind when the field's kind changed, and skips a slot that kind does not declare
(`fieldKindDeclaresKey(kind, "<slot>_media")`). Reason: for a `datetime` with `label_media`
becoming `hidden`, it emits `setFieldMedia{ slot: "label", media: null }` today, which admission
refuses because the media pass runs after the converts, so `appendSyntheticBatchInTransaction`
would refuse `fuzz-suite-20260930-8`'s target and any conversion that drops media. The convert
itself already drops an undeclared slot (`reconcileFieldForKind`), so nothing is lost.

### 2.10 Preview's time read

`lib/preview/engine/dataInstance.ts::answerXPathValue` gains
`case "time": return wireTimeOfDay(raw);` (`lib/domain/temporalValues.ts::wireTimeOfDay`). Reason:
`components/preview/form/fields/DateField.tsx` stores a time as `storageTimeValue(...)`
(`HH:MM:SS.mmmZ`), and with no `time` case the node evaluates with the `Z` tag, where Core reads
`TimeData.uncast`'s zone-less wall clock. The join then reads as UTC in Preview and disagrees with
Core by the viewer's offset. It is also a parity defect today: a label output of a time question
shows a `Z` a device does not. `lib/preview/CLAUDE.md` gains the sentence "A time answer reads as
its wall clock with no zone, as Core's `TimeData.uncast` gives it".

### 2.11 The planner

New `lib/doc/datetimeSplit.ts`:

```ts
export interface DatetimeSplit {
  readonly fieldUuid: Uuid;
  readonly formUuid: Uuid;
  readonly dateUuid: Uuid;
  readonly timeUuid: Uuid;
  readonly dateId: string;
  readonly timeId: string;
  readonly moved: {
    readonly validate: boolean;
    readonly defaultFrom: "preload" | "default" | null;
  };
}
export type DatetimeSplitRefusal =
  | "not-a-date-and-time-question"
  | "self-read-through-a-filter";
export type DatetimeSplitPlan =
  | ({ readonly ok: true; readonly mutations: readonly Mutation[] } & DatetimeSplit)
  | { readonly ok: false; readonly reason: DatetimeSplitRefusal; readonly message: string };
export function planDatetimeSplit(doc: BlueprintDoc, fieldUuid: Uuid): DatetimeSplitPlan;
export type DatetimeSplitsPlan =
  | { readonly ok: true; readonly mutations: readonly Mutation[]; readonly splits: readonly DatetimeSplit[] }
  | { readonly ok: false; readonly fieldUuid: Uuid; readonly reason: DatetimeSplitRefusal; readonly message: string };
export function planDatetimeSplits(doc: BlueprintDoc): DatetimeSplitsPlan;
```

`planDatetimeSplit` returns, in order: `addField D`; `addField T`;
`convertField { uuid, toKind: "hidden" }`; `updateField { uuid, targetKind: "hidden", patch:
{ calculate: J, default_value: null } }`, with `default_value: null` only when the original held
one; the `setTranslation`s of §2.4; and whatever
`lib/doc/kindConversionCascade.ts::planKindConversion({ doc, field: original, toKind: "hidden" })`
adds beyond its own convert (at most a pin of an undeclared written property to `datetime`; it
never changes the effective type). `planDatetimeSplits` walks every `datetime` field in
`doc.moduleOrder`, then each module's `doc.formOrder`, then a depth-first preorder over
`doc.fieldOrder` (a container's children, in sequence, before its next sibling; the planner's own
walk, since `mutations/helpers.ts::walkFormFieldUuids` is not in document order), and applies each plan to a working copy
(`produce(doc, (draft) => applyMutations(draft, plan.mutations))`) before planning the next, so id
and identity allocation sees earlier splits. It stops at the first refusal.

The cutover and the fuzz mapping reach `planDatetimeSplits` through one pure transform,
`lib/doc/platformDeclaration.ts::planContentDeclaration(doc): ContentDeclarationPlan` (pull request
4; part 09 §5, step 1, and part 01 §3, §14): where a document's content runs on neither platform and
the only Web Apps cause is `datetime-question`, it declares Web Apps and appends this planner's
mutations. Its `declared` arm carries `splits: readonly DatetimeSplit[]`, this part's type
unchanged, and its `split-refused` arm carries this planner's `self-read-through-a-filter`. The
split's own mutations are those listed above: the `convertField` to `hidden` carries no `label`
seed, since a Hidden Value declares no label (§2.8's seed serves only the reverse conversion).

The planner never runs the validator; each caller gates the candidate: the builder through
`useBlueprintMutations`' `guardedApply` (`commitVerdicts.ts::mutationCommitVerdictWithPrevalidation`),
which `splitDatetimeQuestion` and `addDatetimeAsTwoQuestions` call (pull request 11, part 07 §2.6);
the cutover through the synthetic writer's absolute gate (`commitVerdicts.ts::mutationCommitVerdict`),
a planner refusal being the recorded blocker `datetime-split-refused` (pull request 13, part 09
§11); and the fuzz mapping, which runs in each generator's `lowerToDoc` through
`lib/doc/platformDeclaration.ts::declaredForContent`, the thin wrapper over
`planContentDeclaration` that throws on any kind but `declared`, and whose draws
`proof/corpus/fuzzSample.ts::admitted` then holds to full validation (`runValidation`) as today
(pull request 4, part 08 §3.4).

Refusal messages, for the builder's toast and the cutover's blocker report:

- `not-a-date-and-time-question`: "Nova can split only a date-and-time question, and this question asks for something else."
- `self-read-through-a-filter`: "This question's own rule reads it through a filtered repeat, which Nova can't move onto the time question. You can simplify that rule and try again."

**The guide.** The split's teaching is part of part 07 §3.4's workflows paragraph
(`lib/agent/authoring/reference.ts`, `AUTHORING_REFERENCE.workflows`, pull request 12), which
names §2.2's calculate over `#form/visit_date` and `#form/visit_time`. Reason this part needs it:
the guide teaches the one shape R2 and R3 recognize (`datePattern.ts::isClockKeepingDate`), so a
model-built join behaves as a split one.

### 2.12 What a worker and HQ see

- Two questions instead of one, each with the original's label; the pickers tell them apart, and
  the author can edit either label.
- A date with no time, or a time with no date, gives a blank value. The original could not be
  partly answered; both are required where it was.
- Web Apps times are minutes (`form_entry/entries.js`, `TimeEntry.serverFormat = 'HH:mm'`);
  Android's are seconds 0 (`views/widgets/TimeWidget.java`).
- A preloaded value with milliseconds may come back 1 ms lower: `DateUtils.java::parseRawTime`
  takes seconds through `Double.parseDouble` and truncates. A preloaded value in the repeated hour
  of a fall-back day comes back as the hour Core's lenient calendar picks for that wall clock; the
  native test of part 08 §5.1 records which (§9).
- HQ's exports gain two columns; `/data/<id>` keeps an instant in `DateTimeData`'s spelling.
- A close condition naming the field moves to `form-action` placement where the field stands in
  no repeat and its answer is statable, and otherwise stays `save-to-case` (§2.4).

### 2.13 The manifest entry

The joined value's bind stands on part 02's entry `questions/hidden-value-bound-xsd-datetime`,
which this part adds nothing to: pull request 1 adds it as `export-use` with no inventory row,
because Nova already binds a Hidden Value that writes a date-and-time property `xsd:dateTime`,
with a widen for the non-writer R3 covers (part 02 §3.5); pull request 3, when R3 lands, completes
its `dispositionCell` and clears the widen (part 02 §4). Reason this part needs it: the platform
table and the lane must not read a bind-only `xsd:dateTime` node as the Web-Apps-unavailable
question. The entry reads `runs` on both platforms, so part 01's binding test needs no feature for
it. The lane's verification over `targeted-datetime-split` is part 02 §4's.

### 2.14 What step 6 reads back

A bind-only node with no control, `type="xsd:dateTime"` and a calculate reads back as a Hidden
Value with that calculate; step 6's reader admits `xsd:dateTime` on a bind-only node exactly when
the node writes a date-and-time property or its calculate is the clock-keeping date, R3 run
backwards, and refuses it otherwise. Spacing and quoting from js-xpath are presentation the
parser discards. The plan's own pull request adds this sentence to
[`6-import.md`](../6-import.md).

---

## 3. `here()` in a case list

### 3.1 What Web Apps does

- Core's screen code installs a placeholder handler while the list is built:
  `src/cli/java/org/commcare/util/screen/EntityScreen.java` adds
  `ScreenUtils.HereDummyFunc(-23.56, -46.66)`.
- Formplayer takes the worker's location only from the navigation request:
  `beans/SessionNavigationBean.java::getGeoLocation` (`geo_location`) into
  `services/MenuSessionFactory.java` (`menuSession.setCurrentBrowserLocation(...)`), read by
  `util/FormplayerHereFunctionHandler.java`, which answers `''` when it has none.
- HQ's Web Apps client never sends one: no JavaScript or template under `corehq` names
  `geo_location` or `geoLocation` at the pin.

So `here()` reads the placeholder while a list is built and `''` everywhere else on Web Apps, the
case detail included. Android installs a handler backed by the device's location on its case
list (`activities/EntitySelectActivity.java`, `hereFunctionHandler`).

### 3.2 From step 4

- **The feature** is part 01's `case-list-here` (Web Apps `unavailable`, Android `runs`, entry
  `expressions-and-data/here-in-a-case-list-calculated-column-or-sort`, whose note pull request 1
  corrects to name the detail). Its use is an expression leaf, refused through the checker's
  `arm-unavailable` with reason `platform-unavailable` wherever a case-list column holds `here`
  (rows, sorts and detail) and Web Apps is declared. Its copy is part 01's, in its three voices
  (part 01 §7, `case-list-here`).
- **Profile.** `SlotProfile.here` stays the slot rule (a case-list calculated column); the platform
  refusal is the second channel's. A form can never read `here()`, as today.
- **Builder** (pull request 11): "Where you are now" (`expressionEditorSchemas.ts`, `HereCard`)
  stays offered where `profile.here` holds, and is shown disabled with part 01's picker line
  (`platformPickerLine`, part 01 §7's value-menu line) in an app that declares Web Apps, through
  the item's rule admission (part 07 §2.5).
- **Agent** (pull request 12): the guide keeps its `here()` sentence and the generated
  `platformSentence` for `case-list-here` follows it (part 07 §3.4).
- **Preview** on Web Apps never meets `here()`: an app that declares Web Apps cannot hold it, so
  Web Apps' value is never read (part 06 §11).
- **Public docs** (pull request 14). `content/docs/building-with-nova.mdx`'s paragraph beginning
  "`here()`, the worker's current location" becomes:

  > `here()`, the worker's current location, belongs in a case list's calculated column, in an app that runs only on Android. On Android it shows the worker's location in the list and in the case's details. Web Apps never shares where the worker is with a case list, so Nova refuses `here()` in an app that runs in Web Apps.

  `content/docs/case-workspace.mdx`'s `here()` paragraph takes one merged edit, held in part 07 §5's
  pull request 14 list, which joins this part's clause (it works in an app that runs only on
  Android, because Web Apps never shares where the worker is with a case list) with part 06's
  Preview sentences. `content/docs/mcp/tools.mdx`'s sentence "In a calculated case-list column,
  `here()` reads where the worker is now" gains "in an app that runs only on Android".
- **Cutover.** No migration moves a column: an app holding `here()` in a case list and an
  Android-unavailable feature is the author's blocker `runs-on-neither` (part 09 §11).

---

## 4. Search fields read in a search-first module

### 4.1 Where CommCare supplies the inputs

- **Web Apps.** Formplayer's query step calls `QueryScreen.updateSession`
  (`src/cli/java/org/commcare/util/screen/QueryScreen.java`), which builds the user-input instance
  (`::getUserInputInstance`, `data/xml/VirtualInstances.java::buildSearchInputInstance`, id
  `search-input:<query datum id>`) and pushes it with the results on the query step
  (`session/CommCareSession.java::setQueryDatum`). A search-first module's query datum is
  `results:inline`, so its forms, list and detail read `search-input:results:inline`. HQ's build
  declares that instance (`app_manager/suite_xml/post_process/instances.py::search_input_instances`,
  admitted by `app_manager/suite_xml/utils.py::is_valid_results_instance_name`).
- **Android** pushes the results alone (`activities/QueryRequestActivity.java`,
  `setQueryDatum(instanceOrError.first)`), so a read of the declared instance has no root and
  throws. Search first is itself Android-unavailable (part 01's `search-first`), so an app that
  holds the read never declares Android.
- **A form opened from a link or an entry point on Web Apps** is rebuilt through
  `services/MenuSessionFactory.java::rebuildSessionFromFrame`; there the query screen's answers are
  its starting values (`session/RemoteQuerySessionManager.java::initUserAnswers`,
  `::getUserQueryValues`), so the form reads the Search fields' starting values, not what the
  worker searched for.

### 4.2 From step 4 (pull request 10)

- **Facts.** `lib/domain/expression/context.ts::FormExpressionFacts` gains
  `searchFirstModule: boolean`, set in `buildFormFacts` to `module !== undefined &&
  moduleOpensOnSearch(module)` (`lib/domain/modules.ts`).
- **Checker.** In `typeChecker.ts`'s term admission, the refusal of an `input` term in form logic
  becomes: refused when `ctx.ruleSet === "form" && !ctx.form?.noMatchesForm &&
  !(ctx.form?.searchFirstModule === true && ctx.profile.scope === "form")`. So the field and
  Connect slots of a search-first module's own forms admit it, and the refusal gains a reason,
  carried by `formLogicFindings.ts` into `INVALID_SEARCH_REF`'s `details.reason`:
  - `form-link`: a form link's slots in a search-first module's own form (scope `session`,
    evaluated in the suite's stack after the form closes). Message: "A form link runs after the
    form closes, where its menu's Search answers are no longer available."
  - `not-search-first`: any other form, whose module does not open on its search. A form of a child
    module of a search-first parent is one of these: its `#search/` names resolve to its own
    module's Search fields (`FormExpressionFacts.searchInputs`), and reading the parent's is step 7,
    group 3's. Message: "Search answers are available only in the forms of a menu that opens on its
    search."

  The checker's other `search-answer-unavailable` site, a slot whose profile lists no such Search
  field, keeps its reason `search-input`, and `unknown-search-input` keeps no reason.
- **Columns.** The `case_list_column_expression` profile already lists the module's Search fields;
  `lib/commcare/validator/rules/case-list/searchInputRefUsesWhenInputPresent.ts` skips its
  calculated-column loop when `moduleOpensOnSearch(mod)`, so a search-first module's list and
  detail columns may read them. The column read of an ordinary search's results detail stays
  refused (step 7, group 4: Nova projects one case list onto both the module's list and its search
  results detail, `lib/commcare/compiler.ts`).
- **Emission.** `lib/commcare/expander.ts` passes `searchAnswers: searchAnswersOf(authoredDoc,
  moduleUuid)` to `buildXFormSource` for every form of a module that opens on its search, as it
  does today for the synthetic no-matches form. The calculated-column print binds the inline
  instance: `lib/commcare/suite/case-list/columns.ts::lookupTermContext` adds
  `searchInputInstanceId: INLINE_SEARCH_INPUT_INSTANCE_ID` when `ctx.caseSource === "results:inline"`,
  and `lib/commcare/suite/case-list/orderPlanOptions.ts::hqExpressionField` adds the same binding
  when `moduleOpensOnSearch(mod)`. The instance declarations follow from the printed tree.
- **Preview.** The choice of a form's `searchAnswers` becomes one pure function,
  `lib/preview/noMatchesForm.ts::formSearchAnswers({ searchInputs, admission, searchFirst,
  searchState, defaults }): SearchInputValues | undefined`: a no-matches form's admitted launch
  gives its answers, as today; a form of a search-first module (`searchFirst`) gets the module's
  completed search's answers (`searchInputInstanceValues(searchInputs, answers)`) when
  `searchState` is `completed`, and otherwise (a link or an entry point opened the form)
  `defaults`, the Search fields' starting values; any other form gets none.
  `components/preview/screens/FormScreen.tsx`'s `searchAnswers` memo calls it in preview mode,
  passing `usePreviewSearchState(moduleUuid)` and, as `defaults`,
  `lib/preview/engine/searchExpressionEvaluation.ts::resolveSearchInputDefaults`' result, the
  function the Search screen fills its prompts with. The form engine already binds
  `INLINE_SEARCH_INPUT_INSTANCE_ID` (`formEngine.ts`, `expressionRuntime`). The case detail read
  `lib/preview/engine/caseDataBinding.ts::loadCaseDataAction` gains a last argument
  `searchAnswers?: Readonly<Record<string, string>>` (plain JSON, so the Server Action's arguments
  stay JSON), used in place of the empty map it gives `withSearchInputExpressionValues` today; the
  detail screen of a search-first module passes the completed search's answers. The results list
  already compiles with the search's values (`serverSearchRead.ts`).
- **Agent checks.** `lib/agent/authoring/evaluationContext.ts::loadFormEvaluationContext` hands
  the submitted `searchAnswers` (or the starting values, when none are supplied) to the evaluated
  form of a search-first module, as it already hands them to the search that form reads.
- **Turning Search first off.** A module whose forms read its Search fields cannot turn Search
  first off in one batch while the reads remain: the gate refuses each read as `INVALID_SEARCH_REF`
  with reason `not-search-first`. `lib/doc/userFacingErrors.ts`'s `INVALID_SEARCH_REF` switches on
  `details.reason`:

  - `not-search-first`:
    > {field} in {form} reads a search answer this form can't get to. Only a form in a menu that opens on its search can read that menu's Search fields. You can turn Search first back on, or read a question or a case property instead.
  - `form-link`:
    > A link from {form} reads a search answer after the form has closed, where CommCare no longer holds it. You can save the answer to a question in the form and read that instead.
  - any other reason keeps today's sentence with its last clause made true: "{field} in {form}
    reads a search answer this form can't get to. Only a form that opens after its menu's search
    can read that menu's Search fields."

  `lib/doc/searchNoMatchesForm.ts`'s header comment's "a `#search/` read outside a no-matches form
  is `INVALID_SEARCH_REF`" becomes "outside a search-first module's own forms".
- **The Web Apps difference** is the Web Apps note of part 01's `search-first` row, which pull
  request 10 adds with the row's two search-input entries (part 01 §4.1, §13). Its substance is
  §4.1's: a form opened from a link or an entry point reads each Search field's starting value,
  not what the worker searched for. Its wording is part 01's, in the table's frame (a lower-case
  clause with no final period, which `platformSentence` opens with "In Web Apps,"). The builder
  shows it beside a `#search/` read in such a form (pull request 11, part 07 §2.8).

---

## 5. The case list's typed search text

### 5.1 What CommCare supplies

- Core adds a `stringquery` node to `session/data` for **every** frame step carrying a non-empty
  `KEY_LAST_QUERY_STRING` extra (`session/SessionInstanceBuilder.java::addUserQueryData`,
  `::getStringQuery`); `::addData` adds a node only for a non-null value, with multiplicity, so the
  node can be absent or several.
- Android writes the extra onto the frame's top step from the case list's search box
  (`activities/CommCareActivity.java::saveLastQueryString`, called from
  `EntitySelectActivity.java::onStop`; `CommCareSession.java::addExtraToCurrentFrameStep` →
  `SessionFrame.java::addExtraTopStep`). The list stops once when a detail opens and again after
  the selection, when the top step may be the new datum's, so one case list can leave the same
  text on two steps.
- Formplayer never sets it (no reference under `formplayer/src/main`), so on Web Apps the node is
  absent.
- An absent node is an invalid path whose value read throws (`XPathPathExpr.java::evalRaw`,
  `XPathNodeset.java::unpack`); `count` of it reads 0 (`XPathCountFunc`), and `if` evaluates one
  branch (`XPathIfFunc`). A read of two nodes throws too (`XPathNodeset.java::unpack`, "more than
  one node"); a numeric predicate picks a position (`core/model/condition/EvaluationContext.java::expandReferenceAccumulator`).

### 5.2 The stored shape

A value arm `{ kind: "case-list-search-text" }` in `ValueArm`, beside `here`, `today` and `now`,
with no parameters. Reason: the value has no identity to hold (no datum supplies it, and its node
names no list), so it is not a `Term`; it is the evaluating entry's one case list's text, like
`here` is the worker's position. `fingerprintquery` is not held in step 4: its only supplier is a
case-list callout, which step 7, group 4 owns, and the plan's own pull request adds it there.

### 5.3 Admission and print

- **Slots.** `SlotProfile` gains `caseListSearchText: boolean`, set in `context.ts::slotContext`
  for field slots and Connect slots (rule set `form`, scope `form`). Elsewhere the checker refuses
  the arm `arm-unavailable` reason `case-list-search-text-slot`: "What the worker typed into a
  case list's search box is available only in a form's questions and Connect settings."
  `formLogicFindings.ts`'s `arm-unavailable` case gains the branch: code
  `XPATH_FUNCTION_CONTEXT_UNAVAILABLE`, `details: { reason: "case-list-search-text-slot" }`, message
  `${owner.slotSubject} reads what the worker typed into a case list's search box, which only a form's questions and Connect settings can read. You can read it in one of the form's questions instead.`
- **Supply.** Admitted only where the entry has exactly one case list: exactly one
  `selected-case` ref in `ctx.supplies.refs` (`lib/domain/entryDatumSupplies.ts::entryDatumSupplies`
  at the form point). Otherwise `datum-not-supplied` with reason `case-list-search-text` and the
  count of case lists, whose checker message has two arms: none, "This form doesn't open after a
  case list, so there's no search box text to read."; several, "This form opens after <n> case
  lists, so CommCare can't tell which search box text it means." `formLogicFindings.ts`'s
  `datum-not-supplied` case maps it to `SESSION_DATUM_NOT_SUPPLIED`, its `details` keeping `slot`
  and `carrier` and taking `reason: "case-list-search-text"` and `caseLists`.
- **Platform.** Part 01's feature `case-list-search-text` (Web Apps `unavailable`, Android
  `runs`, entry `expressions-and-data/session-data-stringquery`), an expression leaf refused
  through the checker's second channel where Web Apps is declared: part 01's
  `expressionLeafFeature` matches the value node `{ kind: "case-list-search-text" }` (part 01
  §2.2), and its copy is part 01 §7's.
- **Type.** Text, held as a string.
- **Builder text and parse.** It prints `instance('commcaresession')/session/data/stringquery`
  (`print.ts`), and `lib/commcare/xpath/formPathBinding.ts` binds exactly that path (the `data`
  branch, before the datum lookup) to the arm. No Nova datum is named `stringquery`, so the bind
  shadows nothing.
- **Wire.** `fromExpression.ts` lowers the arm to `if(count(P) > 0, P[1], '')` with
  `P = instance('commcaresession')/session/data/stringquery`, through
  `emptyRows.ts::guardAbsentNode(P[1], P)` (§6.3). Reason for `[1]`: one case list can leave its
  text on two steps (§5.1), and both nodes hold the same text, so the first reads it where a bare
  read would throw. The Vellum shadow prints the same text.
- **The binding-resolution oracle.** `lib/commcare/validator/bindingResolutionOracle.ts`, rule 1,
  admits `stringquery` beside the entry's datum ids (`SESSION_QUERY_DATA_NAMES = new Set(["stringquery"])`),
  since Core adds it beside the datums.

Copy, `lib/doc/userFacingErrors.ts`, `XPATH_FUNCTION_CONTEXT_UNAVAILABLE`, a new `case
"case-list-search-text-slot"` before the default:

- "{formula subject} reads what the worker typed into a case list's search box, which only a form's questions and Connect settings can read. You can read it in one of the form's questions instead."

Copy, `lib/doc/userFacingErrors.ts`, `SESSION_DATUM_NOT_SUPPLIED`, reason `case-list-search-text`,
read before the `target-not-requested` branch:

- no case list: "{subject} reads what the worker typed into a case list's search box, but {form} doesn't open after a case list. You can read a question or a case property instead."
- several: "{subject} reads what the worker typed into a case list's search box, but {form} opens after {n} case lists, so CommCare can't tell which search it means. You can read it in a form that opens after one case list."

### 5.4 Every place the arm touches

The `here` arm is the model; TypeScript's exhaustive switches name each site.

| Place | Change |
|---|---|
| Schema | `lib/domain/expression/types.ts`: the `ValueArm` type, the value-kind set, `valueSchemas` |
| Traversal | `lib/domain/expression/children.ts`: no children |
| Checker | `typeChecker.ts`: admission (§5.3), typing `scalar("text")` |
| Form grammar and printer | `formPathBinding.ts` (bind), `print.ts` (print) |
| Record grammar and printer | no spelling: `lib/agent/authoring/queryExpressions.ts` gains none, and `printQueryExpression.ts`'s default branch throws for it, as for every form-only arm |
| Wire | `fromExpression.ts` (§5.3); `lib/commcare/csql/representability.ts` lists it with `here` under `form-context-value-not-csql` |
| Preview | `lib/session/types.ts::PreviewCaseTarget` gains `caseListSearchText?: string`, which `components/preview/screens/CaseListScreen.tsx` sets from its filter box's text when the worker selects a case; `lib/preview/engine/entrySessionData.ts::EntrySessionInput` gains `caseListSearchText?: string`, and `entrySessionData` writes `data.stringquery` when it is non-empty. Every app holding the arm runs only on Android, so Preview plays Android there (part 06 §18.4). App Tests and `evaluate_form` type nothing into a list's filter, so they read it blank, as a device does when the worker typed nothing |
| Postgres | `lib/case-store/sql/compileExpression.ts` lists it with `here`'s neighbours that throw "reached a server record query": no Postgres-target profile admits it |
| Reference index | `lib/doc/referenceIndex.ts` records nothing: the arm names no identity |
| Builder card (pull request 10) | `components/builder/shared/expressionEditorSchemas.ts` gains `"case-list-search-text": { label: "Case list search text", icon: tablerSearch, description: "What the worker typed into the case list's search box", component: CaseListSearchTextCard, defaultValue: () => ({ kind: "case-list-search-text" }) }`, offered where `profile.caseListSearchText` holds; `components/builder/shared/cards/expression/GeneralValueCards.tsx::CaseListSearchTextCard` reads "What the worker typed into the case list's search box, blank when they typed nothing."; `RuleFocusContext.tsx` and `ruleNavigation.ts` treat it as `here`. Showing it disabled with the reason in an app that declares Web Apps is pull request 11's (part 07 §2.5) |
| Editor completions (pull request 10) | `lib/codemirror/expressionEditorContext.ts` offers the path, labelled "Case list search text" (the card's label, so the two editors name it alike), where the profile admits it. Offering by declaration is pull request 11's (part 07 §2.5) |
| SA and MCP | authored as form text; no schema changes. The guide row is part 07 §3.4's (pull request 12), which carries this part's sentence: "In a form that opens after one case list, `instance('commcaresession')/session/data/stringquery` reads what the worker typed into that list's search box, blank when nothing." The platform clause is not this sentence's: the generated `platformSentence("case-list-search-text")` follows it (part 07 §3.4) |

---

## 6. The session context fields

### 6.1 What CommCare supplies

`session/SessionInstanceBuilder.java::addMetadata` writes the seven context fields; `::addData`
adds no node for a null value.

| Field | Android | Web Apps |
|---|---|---|
| `drift` | `String.valueOf(long)`, never null: whole hours the device clock was ahead of the server's at the last response (`AndroidInstanceInitializer::getCurrentDrift`, Core `core/network/CommCareNetworkServiceGenerator.java` `driftInterceptor`) | `0`: Formplayer keeps Core's `core/process/CommCareInstanceInitializer.java::getCurrentDrift` |
| `window_width` | absent: `models/AndroidSessionWrapper.java` builds `SessionWrapper` with no width | the browser's `window.innerWidth`, sent only by `cloudcare/static/cloudcare/js/formplayer/menus/api.js`; `form_entry/web_form_session.js` sends none, `objects/SerializableFormSession.java` keeps none, and every form request rebuilds the session with that request's width (`application/FormController.java` → `session/FormSession.java`) |
| `applanguage` | `Localization.getCurrentLocale()` | the same call on Formplayer's per-thread localizer, set by navigation (`session/MenuSession.java` → `util/SessionUtils.java::setLocale`) and the in-form language switch; form requests do not set it |

### 6.2 Types and admission, from pull request 10

- **Types.** `typeChecker.ts`'s `session-context` term: `drift` and `window_width` type `int`
  (held `string`, `nodes("int", "string")`), the others `text`. Postgres follows the type with no
  change: `lib/case-store/sql/compilePredicate.ts::readsAsDeviceText` compares an `int` operand as
  a number.
- **`drift`**: admitted wherever a context field is today. Part 01's feature `clock-drift`
  (Web Apps `different`, Android `runs`).
- **`applanguage`**: admitted wherever a context field is today; its values are the app's
  language codes (`localization.wireCodes`), which the builder offers as literal picks for an
  `applanguage` comparison (pull request 11, part 07 §2.5). Part 01's feature `app-language` (Web
  Apps `different`, Android `runs`).
- **`window_width`**: `SlotProfile` gains `windowWidth: boolean`, true only for slots CommCare
  evaluates while a menu or a list loads: every module slot (`slot.entity === "module"`: the module
  display condition, the case list's filter and columns, every search setting) and a form's
  `form_display_condition`. Every slot a form evaluates refuses it: field slots, Connect slots,
  case-operation slots (scope `submission`), form-link slots and `lookup_options_source`. The
  refusal is `arm-unavailable` reason `window-width-in-form`, mapped by `formLogicFindings.ts` to
  `XPATH_FUNCTION_CONTEXT_UNAVAILABLE` with `details.reason: "window-width"`, on every
  declaration. Part 01's feature `window-width` (Web Apps `runs`, Android `unavailable`) refuses
  the remaining reads where Android is declared.

Copy, `formLogicFindings.ts` and `userFacingErrors.ts` (`XPATH_FUNCTION_CONTEXT_UNAVAILABLE`, reason
`window-width`):

> {formula subject} reads the window width, which CommCare sends only while a menu or a list loads, so a form can't rely on it. You can use it in a display condition or a case list instead.

The notes of the three features are part 01's rows, added in pull request 10 (part 01 §4.1 for
`window-width`, §4.2 for `clock-drift` and `app-language`); this part states no note text. What
each note must say is §6.1's table: `drift` is always 0 on Web Apps and the device's whole-hour
offset on Android, `applanguage` is reliable on Web Apps only when a menu, a list or a form opens,
and `window_width` is the browser's width on Web Apps and absent on Android.

### 6.3 The count guard

`lib/commcare/sessionContext.ts` gains `ABSENT_CAPABLE_SESSION_CONTEXT_FIELDS = ["window_width",
"applanguage"] as const`. `lib/commcare/xpath/wire/emptyRows.ts` gains
`guardAbsentNode(read: WirePath, counted: WirePath = read): WireExpr`, which builds
`if(count(<counted>) > 0, <read>, '')`. `fromExpression.ts`'s `session-context` arm guards a read
of an absent-capable field; the `case-list-search-text` arm always guards (§5.3). Reason: `count`
of an invalid path reads 0 and `if` evaluates one branch, while every unpacking read of an absent
node throws in a calculate and a condition, and fails a case list or shows `<invalid xpath: …>` in
it depending on its entity factory (`cases/entity/NodeEntityFactory.java::getEntity`,
`cases/entity/AsyncEntity.java::evaluateField`). `drift` is never absent, and `deviceid`,
`appversion`, `username` and `userid` are supplied on both platforms
(`session/FormplayerInstanceInitializer.java`, `CommCareInstanceInitializer.java`), so they keep
their bytes. Reads of these fields stored today change bytes once, at their next publish.

`lib/commcare/xpath/wire/CLAUDE.md`'s "Reads of rows that may be empty" gains: "A session read
that can be absent (`window_width`, `applanguage`, the case list's search text) prints
`if(count(<read>) > 0, <read>, '')` for the same reason (`emptyRows.ts::guardAbsentNode`)."

### 6.4 The gate on `window_width` in a form

The refusal in §6.2 rests on what Core does with a bare form read when the width is absent on a
later request. Reading settles the mechanism (`XPathPathExpr.java::evalRaw`: an absolute path with
no template path is an invalid nodeset, which `XPathNodeset.java::unpack` refuses), with one
caveat planning found: the check runs once per expression object (`templatePathChecked`), and
Formplayer caches each session's `FormDef`
(`services/FormDefinitionService.java::getFormDefWithCache`), so a request served from the cache
reuses an expression already checked while the width was present, and reads `''`, while one
served after a cache miss deserializes a fresh `FormDef` from the session's stored definition
(`::getFormDefFromSession`, `FormDefStringSerializer.deserialize`) and throws. A deserialized
expression starts unchecked, as a parsed one does: `XPathPathExpr.java::writeExternal` and
`::readExternal` do not carry `templatePathChecked`.

**The execution.** Two methods of `proof/native/core/SessionContextRuntimeTest.java`, part 08's
class in the `expression` family (registered in `proof/native/families.py::CORE_CLASSES` as
`"SessionContextRuntimeTest": "expression"`), the same class that holds the guarded reads of part
08 §5.2; the evidence is the `expression` family's JSON that
`proof/native/producers/emit-expression-evidence.ts` writes, laid out by part 08 §5.2. The form is
an XForm whose calculate reads `instance('commcaresession')/session/context/window_width` bare
and, in a second calculate, under the count guard. Each method initializes it with a session root
from `SessionInstanceBuilder.getSessionInstance(…, "1024", "en")`, then initializes again with a
root built with width `null`:

- `windowWidthReadOnACachedForm`, arm (a): re-initializes the same `FormDef`, as Formplayer's
  cache hit does;
- `windowWidthReadOnAFreshForm`, arm (b): re-parses the XForm into a fresh `FormDef`, which stands
  for the `FormDef` a cache miss deserializes, since neither carries `templatePathChecked`.

The first run is decisive by assertion. Both methods assert the guarded calculate reads `''`;
`windowWidthReadOnACachedForm` asserts the bare calculate reads `''`, and
`windowWidthReadOnAFreshForm` asserts it throws `XPathTypeMismatchException`. Each bare
assertion's failure message names what the calculate gave instead (the value read, or the
exception's class and message), so the slice's verdict is the readout, and arm (b) alone decides
the outcome. A green slice is outcome A. A red one whose `windowWidthReadOnAFreshForm` failure
names the value `''` is outcome B, after which that assertion flips as outcome B's list says. A red
one whose only failure is the cached arm throwing is still outcome A, and that assertion takes the
throw it showed. A failure of a guarded assertion is a defect in the class or the guard, fixed
before the run counts. The run is a hand-started dispatch of the `expression`
family on pull request 10's branch, before pull request 10's manifest text is written and before
the stack merges (`proof/README.md`, how to start a run by hand; part 08 §6.3 lists it among the
runs by hand), never on a laptop. Reason for two arms: a single re-initialization of one instance
models only the cache hit, which can read `''` where a cache miss throws, and so would pick the
wrong outcome.

**Outcome A, expected: arm (b) throws.** Ship §6.2 as written, with part 02 §8.4's outcome A: the
REFUSED manifest entry `expressions-and-data/session-context-window-width-in-form-logic`, whose
`reasons.named` cites `SessionContextRuntimeTest` and
`services/FormDefinitionService.java::getFormDefWithCache`, and its lane reader. Part 01's
`window-width` row stands as part 01 §4.1 writes it (runs / unavailable, with its `refusal`), and
Preview's cells are part 06 §23.3's. The two methods stay as the retained evidence, asserting what
the run showed: (b) throws, and (a) reads `''` (or throws, where the run showed that).

**Outcome B: arm (b) reads `''`.** Every part follows:

- **This part.** Drop the profile fact `windowWidth` and the `window-width-in-form` refusal, with
  its copy: `window_width` is admitted wherever a context field is, form logic and every record
  slot included. The count guard stays, so a read on a later answer in a form, or on Android,
  reads blank.
- **The manifest** is part 02 §8.4's outcome B: no REFUSED entry, no reader; the HELD entry
  `expressions-and-data/session-context-window-width` takes no value class and no narrow and reads
  `different / different`; the search value entry
  `case-search/runtime-values-read-from-the-session-context-window-width` reads `runs / different`.
- **The platform table** (part 01 §4.1): `window-width` reads `different / different`, carries no
  `refusal`, and `expressionLeafFeature` no longer names it; the CSQL entry moves out of it into a
  feature of its own, `window-width-in-search` (runs / different), so each feature's readings equal
  its entries' (part 01 §8.2, rule 3). The notes are part 01's, and part 01 §4.5's pull
  request 10 counts follow.
- **Preview** keeps two session contexts in a form and writes the outcome-B cells (part 06 §18.3,
  §23.3).
- **The test** asserts both arms read `''`: `windowWidthReadOnAFreshForm`'s bare assertion flips
  from the throw to `''`, and the class stays the retained evidence.

### 6.5 Authoring surface

- **Builder** (pull request 10): `components/builder/shared/sessionContextPresentation.ts` makes
  `drift`, `window_width` and `applanguage` `editable`, labelled "Device clock offset", "Window
  width" and "App language"; `TermCard.tsx` offers `window_width` only where
  `profile.windowWidth` holds. `lib/codemirror/expressionEditorContext.ts::SESSION_CONTEXT_OFFERED`
  gains the three with the cards' labels, `window_width` filtered by the same fact, so the XPath
  editor never offers it in form logic and offers it in every slot the profile admits. Pull request
  11 adds the declaration filter on these same choices (part 07 §2.5): `TermCard.tsx` admits each
  item through the item's rule admission and shows a refused one disabled with part 01's picker
  line (`platformPickerLine`), and the completions are filtered by the slot's declared platforms.
- **SA and MCP**: form text binds all seven today (`formPathBinding.ts`), and the record dialect's
  `session('<field>')` builds the term (`queryExpressions.ts`); neither changes. The guide's
  context row (pull request 10, `MODEL_CONTEXT_VERSION` `"v5-hq-round-trip-platforms.10"`, part 07
  §3.9) names the three with their types and where each is admitted.

---

## 7. A form read inside a row predicate

### 7.1 How Core evaluates it

`core/model/condition/EvaluationContext.java::expandReferenceAccumulator` offers a step's
predicates to `tryBatchChildFetch` in the outer context (a bind's node) and evaluates the rest row
by row in `rescope(row, …)`. For `casedb` and indexed lookup tables,
`cases/util/StorageBackedTreeRoot.java::collectNativePredicateProfiles` takes each leading
predicate on an indexed path (`cases/instance/CaseInstanceTreeElement.java::getStorageIndexMap`:
`@case_id`, `@case_type`, `@status`, `index/*`, `@owner_id`, `@external_id`, `@category`,
`@state`) and evaluates its right side in the outer context; in-memory fixtures do the same through
`core/model/instance/utils/TreeUtilities.java::tryBatchChildFetch`. Row by row, an absolute
main-instance path contextualized against a row of another instance is cloned unbound
(`core/model/instance/TreeReference.java::contextualize`), so `/data/rep/q` names every `rep`
entry and `XPathEqExpr` throws on more than one; in the batch path it names the bind's own entry.
`current()` is the original context, the outer node, under both (`::rescope`,
`::getOriginalContext`). So the outcome depends on which predicates are indexed and come first,
not on the platform. Vellum keeps `current()/…` verbatim on load and save (js-xpath
`src/models.js`: a function call prints its name and arguments, a path its filter and steps;
Vellum's `invertedHashtagMap` holds only question paths), while a shadow `#form/rep/q` comes back
as `/data/rep/q`.

Today Nova's checker reads such a read in the slot's context (`typeChecker.ts`'s `many-values`
rule computes plurality from the slot's node), and the wire prints the authored spelling
(`lib/commcare/xpath/wire/formReads.ts::formReadToWire`; only `default_value` is forced to
`current`). Preview gives a predicate the candidate row as its context
(`lib/preview/xpath/evaluator.ts::xpathPredicateContext`), as Core's row-by-row path does.

### 7.2 The print, from pull request 10

In `formReadToWire`, a read spelled absolute or as a hashtag (`spelling` absent or `"absolute"`)
prints with spelling `"current"` (`current()/<relative path from types.sourceNode>`) when both
hold:

1. the innermost active row scope (`context.ts::activeRowScope(types)`) is a secondary-instance
   row: `kind` `case`, `table` or `location` (not a form repeat row, `root: "form"`);
2. the read's target path passes through a repeat node that is also an ancestor-or-self of
   `types.sourceNode` in the form graph (`projection.graph.path`), so the read crosses a repeat
   the slot is in, or the repeat whose own slot it is. A repeat's own `relevant` has the repeat as
   its source node (`context.ts::slotContext`, `sourceNode = { kind: "field", uuid: slot.uuid }`),
   and Core evaluates it per repeat entry, so a `#form/rep/q` read there prints `current()/q`.

Every other read keeps its bytes: a read crossing no such repeat, a read outside a row predicate,
a read inside a form repeat row's filter, and every read in a slot with no source node (a form
link's slots). The rule is in the one lowering every target uses, so the XForm attribute, the
suite, HQ's JSON and Preview's text print it alike. The Vellum shadow follows from the printed
tree: `lib/commcare/xpath/wire/serialize.ts::shadowEligibility` writes a shadow only for a tree
holding a hashtag-spelled `form` path, and the moved read is a `current` path
(`formReads.ts::formReadToWire` returns `w.current(steps)`), which is none. So where the moved read
was the expression's only hashtag form read, the attribute carries `current()/../q` and no
`vellum:calculate` is written; where another hashtag form read
remains, the shadow is written and holds `current()/../q` beside that read's `#form/` path. The
checker needs no change: its reading is now what every runtime evaluates. No document changes;
forms holding such a read change bytes at their next publish. `lib/commcare/xpath/wire/CLAUDE.md`
gains a paragraph stating the rule, its reason and the shadow it leaves.

Example: a calculate in `rep` reading `instance('casedb')/casedb/case[@case_type = 'visit'][dose = #form/rep/q]`
prints `instance('casedb')/casedb/case[@case_type = 'visit'][dose = current()/../q]` in the
attribute, and has no shadow, since that was its only hashtag form read. Today the same calculate
has a shadow holding `#form/rep/q`; the change removes it. With a sibling root read added,
`count(instance('casedb')/casedb/case[@case_type = 'visit'][dose = #form/rep/q]) > #form/limit`
prints `current()/../q` in both the attribute and the shadow, with `/data/limit` in the attribute
and `#form/limit` in the shadow.

---

## 8. Manifest entries and inventory rows

Every manifest entry, inventory row and `manifest.test.ts` edit this part's reads need is part
02's, which owns that text; this part restates none of it.

**Pull request 1, then 3:** `questions/hidden-value-bound-xsd-datetime`, added as `export-use`
with no row and completed when R3 lands (part 02 §3.5, §4; §2.13 here).

**Pull request 10:** which entry each read of this part lands on, with the section of part 02
that writes it:

| Read | Entries | Part 02 |
|---|---|---|
| the case list search text (§5) | `expressions-and-data/session-data-stringquery` → HELD, narrowed to an entry with exactly one case list | §8.1 |
| `drift`, `applanguage` (§6) | `expressions-and-data/session-context-drift` and `session-context-applanguage` → HELD | §8.1 |
| `window_width` (§6) | `expressions-and-data/session-context-window-width` and, in outcome A of §6.4, the new REFUSED `session-context-window-width-in-form-logic` with its lane reader | §8.4 |
| the three context fields in search values (§6) | `case-search/runtime-values-read-from-the-session-context-drift-window-width` split into one entry per field | §8.3 |
| Search fields in a search-first module (§4) | `expressions-and-data/search-input-read-in-form-expressions-of-an-inline-search-module` → HELD; the new `search-input-results-read-in-the-case-list-of-an-inline-search`; `search-input-results-read-in-the-search-results-detail` stays HELD-NEW for step 7, group 4 | §8.2 |
| all of the above | `HELD_INSTANCE_READS` and `WAITING_INSTANCE_READS` | §8.5 |

The lane's verification of these entries in pull request 10 is part 02 §8.6's.

---

## 9. Tests and proofs

Each test names the contract it proves. Database tests are none: nothing here reaches Postgres
beyond a type the compiler already follows.

**Pull request 3, the split's groundwork**

- `lib/domain/expression/__tests__/typeChecker.test.ts`: in form logic the clock-keeping date types
  `datetime` held `"date"`; `date(format-date(X, '%Y-%m-%d'))` and a preset pattern type `date`;
  the record rule set types every `date-coerce` `date`.
- `lib/domain/expression/__tests__/inference.test.ts`: a Hidden Value calculated by the
  clock-keeping date is `datetime`, held `"date"` and not clock-lost, writer and non-writer; the
  same calculate under a text-typed written property is clock-lost (R3 follows the property).
- `lib/domain/__tests__/fieldValueType.test.ts` (new): R3's three arms.
- `lib/commcare/xpath/wire/__tests__/instantAgreement.test.ts`: the clock-keeping date as a
  comparison operand classes `typed` and lowers through `typedInstantValue`.
- `lib/commcare/__tests__/datetimeSplitXform.test.ts` (new): `toWire` and `serializeWire` of J
  inside a built form give §2.3's calculate, the bind `type="xsd:dateTime"` for a writer and a
  non-writer, the `vellum:calculate` shadow, and an unchanged `nova_datetime_` sibling for the
  writer; inside a repeat, the hashtag paths of the repeat.
- `lib/domain/__tests__/datetimeSplitIdentity.test.ts` (new): the two UUIDs of §2.5; attempt 1
  differs from attempt 0.
- `lib/doc/__tests__/mutations-fields-convertField.test.ts`: `datetime` → `hidden` converts;
  `hidden` → `datetime` and `hidden` → `text` convert with a `label` seed and are refused without
  one; an unrelated pair stays refused.
- `lib/doc/__tests__/store.test.ts`: undo of `text` → `hidden` and of a split restores the document
  exactly (the store's own undo, through `deltaBetween`).
- `lib/doc/__tests__/diffDocsToMutations.fuzz.test.ts`: kind changes that drop media replay to the
  target (`applyMany(diffDocsToMutations(prev, next))` deep-equals `next`).
- `lib/doc/__tests__/datetimeSplit.test.ts` (new): over the shared original
  `lib/doc/__tests__/datetimeSplitFixture.ts::datetimeSplitOriginal()` (part 08 §4.1's content,
  shared with the targeted document and the `expression` family) and over fixtures of its own (a
  writer with a preload, a non-writer with a default and `label_media`, a validate with its message
  in two languages, one inside a repeat, one inside a section): every new slot round-trips through
  `printFormExpression` and the parser; the result passes `mutationCommitVerdict` (no app declares a
  platform at pull request 3's head, since `appSettings.runsOnlyOn` lands in pull request 4);
  `applyMany(diffDocsToMutations(prev, target))` deep-equals the target; ids
  avoid a sibling `visit_date`; `planDatetimeSplits` over two questions in one form allocates in
  order; each refusal reason with its message.
- `lib/preview/xpath/__tests__/fixtures/coreDateParity.ts`: a node storage `time` (`TimeData`
  cast from `value`, built in Preview through `answerXPathValue("time", storageTimeValue(value))`),
  a row reading a time node as text, and the join row
  `format-date(date(format-date(if(d = '' or t = '', '', concat(d, 'T', t)), '%Y-%m-%dT%H:%M:%S.%3%Z')), '%Y-%m-%dT%H:%M:%S.%3%Z')`
  in the four zones, held by `coreDateParity.test.ts` and `CoreDateParityRuntimeTest.java`.
- `proof/native/core/DatetimeSplitRuntimeTest.java` (new, `expression` family): part 08 §5.1's
  file, evidence and rows. Its rows take, beside part 08's, the three this part relies on (§2.12):
  a time in a spring-forward gap and one in a fall-back repeated hour, in each of the four zones,
  and a preloaded case value `…000000Z` that rejoins to its instant, with the repeated hour's answer
  recorded. For a date and a time entered, the Hidden Value holds `DateTimeData` equal to what
  `DateTimeData.cast` of the zone-less wall clock holds (what the original question held for the
  same entry), and the writer's `nova_datetime_` text names the same instant; a blank date or time
  gives a blank value.
- `targeted-datetime-split` (new): part 08 §4.1's document, built from the shared
  `datetimeSplitOriginal()` with `planDatetimeSplits` applied, with its expectations
  `split-writer-joins`, `split-reader-joins`, `split-joins-compare-later` and
  `split-joins-compare-earlier`. Part 08 §4.1 also takes this part's comparison of two joins: the
  text question `note`, whose `relevant` `#form/due_at >= #form/planned_at` compares two split
  values of the same form, which reads each as a date and time held as a `Date`, as R2 types it,
  where a text value would compare as text. Every served reader reads it in the run started by hand at pull request 3's head (part
  08 §6.3); the pull request lane runs no served reader.

**Pull request 4**: the question's refusal is part 01's validator rule and binding test; this part
adds `lib/commcare/validator/rules/__tests__/platforms.test.ts` cases for a date-and-time question
at the form root, in a group and in a repeat, each located at the field with part 01's
`platformRefusalMessage` as its message and `platformBuilderSentence` as its builder line (part 01
§7), and the same question admitted where Android only is declared. It also adds the split's case
under a declaration to `lib/doc/__tests__/platformDeclaration.test.ts`: over the shared
`datetimeSplitOriginal()` in an app that declares `runsOnlyOn: "web-apps"`, the date-and-time
question fails `mutationCommitVerdict` with `PLATFORM_FEATURE_UNAVAILABLE`, and the same document
with `planDatetimeSplit`'s mutations applied passes it with no `PLATFORM_FEATURE_UNAVAILABLE`
finding.

**Pull request 10, expression reads**

- `typeChecker.test.ts`: a `#search/` read admitted in a field and a Connect slot of a search-first
  module's form, refused with reason `form-link` in its form link's condition and with reason
  `not-search-first` in a child module's form and outside a search-first module; `case-list-search-text` admitted with one case list, refused with none and
  with two (parent select), and refused in a record slot; `window_width` refused in each form slot
  kind and admitted in a module slot and a form display condition; `drift` and `window_width` type
  `int`.
- `lib/commcare/validator/__tests__/formLogicFindings.test.ts`: each mapping with its code,
  `details` and message: `arm-unavailable` `case-list-search-text-slot` to
  `XPATH_FUNCTION_CONTEXT_UNAVAILABLE`; `datum-not-supplied` `case-list-search-text` to
  `SESSION_DATUM_NOT_SUPPLIED` with no case list and with two; `arm-unavailable`
  `window-width-in-form` to `XPATH_FUNCTION_CONTEXT_UNAVAILABLE` reason `window-width` (outcome A
  of §6.4; under outcome B this case is dropped); and `search-answer-unavailable` to
  `INVALID_SEARCH_REF` with reasons `form-link` and `not-search-first`.
- `lib/doc/__tests__/userFacingErrors.test.ts`: the builder sentence of each of those mappings, and
  `INVALID_SEARCH_REF`'s default for a finding with no reason.
- `lib/commcare/validator/rules/case-list/__tests__/searchInputRefUsesWhenInputPresent.test.ts`: a
  calculated column reading a Search field passes in a search-first module and is refused in an
  ordinary search module.
- `lib/commcare/xpath/__tests__/expressionAst.roundtrip.test.ts`: the case list search text path
  and the three context fields round-trip.
- `lib/commcare/xpath/wire/__tests__/fromExpression.test.ts`: the guarded prints of `window_width`,
  `applanguage` and the search text; `drift` and `userid` unguarded.
- `lib/commcare/xpath/wire/__tests__/formReads.test.ts`: §7.2's rule: a repeat-crossing read in a
  `cases`, a `table-rows` and a `locations` predicate prints `current()/../q` in the attribute;
  where it is the expression's only hashtag form read, `serializeWire` in vellum mode gives no
  shadow; with a sibling `#form/limit` read, the shadow holds `current()/../q` beside
  `#form/limit`; a `#form/rep/q` read in a casedb predicate of the repeat `rep`'s own `relevant`
  prints `current()/q`; a read of a root question, of another repeat, outside a predicate, inside a form
  repeat row's filter, and in a form link's condition keeps its bytes; `default_value` unchanged.
- `lib/preview/xpath/__tests__/rowPredicateCurrent.test.ts` (new): Preview evaluating the printed
  text over a two-entry repeat gives each entry its own count.
- `lib/commcare/__tests__/bindingResolutionOracle.test.ts`: a form reading `stringquery` passes rule 1.
- `components/preview/screens/__tests__/noMatchesForm.test.ts`, through §4.2's pure
  `lib/preview/noMatchesForm.ts::formSearchAnswers`: a search-first module's form receives the
  completed search's answers, the starting values when its search has not completed (a link or an
  entry point opened it), and a no-matches form its admitted launch's answers; a form of any other
  module receives none. `lib/preview/engine/__tests__/entrySessionData.test.ts`: the session holds
  `stringquery` when a filter text was typed and none otherwise.
- `proof/native/core/SessionContextRuntimeTest.java` (new, `expression` family): part 08 §5.2's
  file, holding the guarded reads and §6.4's two gate methods, `windowWidthReadOnACachedForm` and
  `windowWidthReadOnAFreshForm`. Of its guarded reads this part relies on the case list search
  text's print, `if(count(P) > 0, P[1], '')` (§5.3), asserted with the text absent, on one step,
  and on two steps, where a bare read throws.
- `proof/native/core/RowPredicateCurrentRuntimeTest.java` (new, `expression` family): part 08
  §5.2's file and evidence, whose four rows are the ones this part's rule rests on (§7.1, §7.2):
  a two-entry repeat `visits` whose hidden value counts rows whose `kind` equals the entry's own,
  through a `casedb` predicate Core answers through its index, one it evaluates row by row (a
  `contains()` test) and an in-memory fixture's attribute predicate, and the same repeat's own
  `relevant` reading its `kind` in a non-indexed `casedb` predicate. The bare `/data/visits/kind`
  print (the retained control) throws on the non-indexed predicates and answers per entry on the
  indexed one; Nova's `current()/../kind` print, and `current()/kind` in the repeat's own
  `relevant`, answer per entry on all four.
- Targeted documents. The documents are part 08's (§4.4, §4.5, §4.7), and part 08's pull
  request 10 file list holds the two edits of existing documents below:
  - `targeted-inline-search-reads` (`proof/targeted/documents/inlineSearchReads.ts`): "Check in"
    gains a hidden value starting from `#search/patient_name` and "Find patient"'s list gains a
    calculated column reading it; its intent expects the searched name in both.
  - `targeted-session-context-reads` (new): part 08 §4.4's document, declared Web Apps only. Of its
    contents this part relies on the module display condition
    `instance('commcaresession')/session/context/window_width > 0`, a calculated column showing the
    width, a Search field's starting value reading it (the search-value read part 02 §8.6's
    verification expects), and the form's hidden values reading `drift` and `applanguage`.
  - `targeted-case-list-search-text` (new): part 08 §4.5's document, declared Android only, which
    builds the value arm itself (`caseListSearchText()`, never a term) in a hidden value and gives a
    question a `relevant` comparing the arm with `''`.
  - `targeted-instance-reads` (`instanceReads.ts`) gains a repeat whose calculate counts cases by
    a predicate reading the row's answer, walked with two rows.

---

## 10. Production and the cutover

A content-free, read-only scan of production, which the person approved, was made during planning;
no count from it enters this plan, and what it found is stated where it decides something:

- **The split runs in production.** A few stored apps run on neither platform, each because of a
  date-and-time question beside a single-date Search field, so `planContentDeclaration` declares
  them Web Apps only and splits their date-and-time questions (part 09 §5, step 1). A few others
  become Android only for a date-and-time question alone, which needs no split.
- **No clock-keeping date is stored**, so count 1 below meets nothing there: rules R2 and R3 retype
  no stored expression, and no `target-gate` blocker of that kind and no drift from it arise.
- **No `drift`, `window_width` or `applanguage` read is stored**: the session context reads
  production holds are of `userid` and `username` alone, with no `deviceid` read. So §6.2's typing
  (pull request 10) meets nothing stored, count 3 below meets nothing there, and under either
  outcome of §6.4's gate no stored `window_width` read is refused.

The cutover's scan (pull request 13) is part 09's, and its report carries, as content-free lines
(part 09 §6), the counts this part needs, by class, which hold for every database it runs on:

1. stored form-logic expressions already holding a clock-keeping date, by writer and non-writer.
   R2 and R3 retype each, and both outcomes are decided. A hit the target gate refuses (a
   clock-keeping date compared with a date, `incompatible-values` reason `date-datetime`) is the
   author's `target-gate` blocker before the window (part 09 §11, "Blockers by rule"). A hit the
   gate admits is accepted: its bind follows R3 at the next publish, and where it is the calculate
   of a Hidden Value writer that alone types its property (`lib/domain/CLAUDE.md`, the writer
   opinions), the property's derived type moves from `date` to `datetime`. The
   dry run counts that as case schema drift against the stored `case_type_schemas` rows, and the
   window's planned drift step writes exactly the counted drift (part 09 §6, §14);
2. `datetime` fields split, by writer and non-writer, in apps whose content runs on neither
   platform (the split's reach);
3. stored `session-context` reads of `drift`, `window_width` and `applanguage`, by field and slot
   class. Any read that stops type-checking under §6.2's types is a `target-gate` blocker for the
   author before the window (part 09 §11, "Blockers by rule"), and so, under outcome A of §6.4, is
   a `window_width` read in a form slot; under outcome B no form-slot `window_width` read is a
   blocker, and the line only counts. A `drift` or `window_width` read that still type-checks as
   the calculate of a Hidden Value writer that alone types its property retypes that property from
   text to a whole number,
   which the dry run counts as case schema drift and the window's drift step writes, as in count
   1;
4. none for the search text, the Search field reads in search-first forms or the `current()`
   print: the first two are refused at parse or by the checker today, and the third changes no
   document.

The split's cutover transform is part 09 §5's: step 1, `declare-platforms`, calls
`lib/doc/platformDeclaration.ts::planContentDeclaration` (pull request 4), which calls
`planDatetimeSplits` and carries its `DatetimeSplit`s, and step 2 removes unplayed media. Its
notice is part 09 §12's. The fuzz mapping's call of the same transform, through
`declaredForContent`, is part 08 §3.4's.

---

## 11. How this part lands in the stack

- **Pull request 3, the split's groundwork:** §2.5 to §2.11: `datePattern.ts` (R2's
  recognizers and `clockKeepingJoin`), the `typeChecker.ts` case, R3 in `fieldValueType.ts` with
  `bindType.ts`'s docblock, `datetime.convertTargets`, `isRepresentableConversion`,
  `convertNeedsLabelSeed`, the `convertField` label seed in `types.ts`, `mutations/fields.ts`,
  `mutationTargetAdmission.ts` and `diffDocsToMutations.ts`, the media diff fix, Preview's time
  read, `instant.ts`'s import, `lib/domain/datetimeSplitIdentity.ts`, `lib/doc/datetimeSplit.ts`,
  the tests of §9, and the subtree docs: `lib/domain/CLAUDE.md` (§2.7's sentence),
  `lib/domain/expression/CLAUDE.md` ("The clock-keeping date": R2 and why),
  `lib/commcare/CLAUDE.md` (the datetime case-write paragraph names the Hidden Value bound by R3),
  `lib/preview/CLAUDE.md` (the time read) and `lib/doc/CLAUDE.md` (conversions are representable
  both ways; the split planner). The same pull request carries part 02 §4's completion of
  `questions/hidden-value-bound-xsd-datetime` (§2.13) and part 08's `DatetimeSplitRuntimeTest`,
  shared fixture and `targeted-datetime-split` (part 08 §5.1, §4.1), with this part's rows of §9.
- **Pull request 4, the declaration:** the date-and-time question's refusal (§1.3) through part
  01's feature, and its tests. The `case-list-here` refusal (§3) lands here too, through the same
  channel. `lib/doc/platformDeclaration.ts::planContentDeclaration` lands here too (part 01 §3,
  §14; part 09 §5), calling this part's `planDatetimeSplits`, with §9's case of the split under a Web
  Apps declaration in `platformDeclaration.test.ts`.
- **Pull request 10, expression reads:** §4 to §7: the profile facts `caseListSearchText` and
  `windowWidth`, `FormExpressionFacts.searchFirstModule`, the checker changes, the arm with every
  place of §5.4 (its builder card and editor completion included), the context types and their
  editable builder choices and completions (§6.5), the count guard, the `current()` print, the
  oracle's admission, Preview's supplies, the evaluation context, the copy, and the guide rows
  behind `MODEL_CONTEXT_VERSION` `"v5-hq-round-trip-platforms.10"`. The window width's native run
  (§6.4) comes first, by hand, before the manifest text. With them land, by their owners: the
  manifest flips and their rows (part 02 §8, per §8 here); the native tests and targeted documents
  (part 08 §5.2, §4.4, §4.5, with this part's rows of §9); part 01's pull request 10 rows,
  `case-list-search-text`, `window-width`, `clock-drift` and `app-language` with their entries,
  readings and notes, and `search-first`'s two search-input entries and Web Apps note (part 01
  §4.1, §4.2, §13; outcome B of §6.4 adds `window-width-in-search`); and Preview's cell-table
  rows marked (10), on the cells whose reading is neither `runs` nor `not-applicable` (part 06
  §23.3). The docs it makes false or incomplete move with it:
  - `lib/commcare/xpath/wire/CLAUDE.md` gains §6.3's and §7.2's paragraphs;
  - `lib/domain/expression/CLAUDE.md` names the arm and the context types;
  - `lib/commcare/CLAUDE.md`, "Secondary instances": "The authoring choices offer four
    (`deviceid`, `appversion`, `username`, `userid`); the other three differ by platform." becomes
    "The authoring choices offer all seven. `drift` and `window_width` type as whole numbers;
    `window_width` is admitted only in a slot CommCare evaluates while a menu or a list loads; and
    `window_width` and `applanguage`, which can be absent, print under the count guard
    (`xpath/wire/emptyRows.ts::guardAbsentNode`). The case list's search text,
    `session/data/stringquery`, is a value arm admitted in a form that opens after exactly one case
    list, printed `if(count(P) > 0, P[1], '')`." Under outcome B of §6.4 the clause "`window_width`
    is admitted only in a slot …" is left out;
  - `lib/domain/CLAUDE.md`, the forms and modules paragraph: `searchInputNameResolver` "resolves
    inside a no-matches form alone" becomes "resolves inside a no-matches form and the forms of a
    module that opens on its search";
  - `lib/preview/CLAUDE.md`, after the no-matches paragraph: "A form of a search-first module
    receives its completed search's answers, or each Search field's starting value when a link or
    an entry point opened it (`noMatchesForm.ts::formSearchAnswers`); the entry session writes
    `session/data/stringquery` from the case list's filter text (`entrySessionData.ts`).";
  - `lib/session/CLAUDE.md`'s bullet opening "`previewCaseTarget` means one exact Form is opening
    with an ordered `cases`" adds "and, after a case list's filter, `caseListSearchText`, which the
    entry's session holds as `stringquery`";
  - `components/builder/CLAUDE.md`'s "Cards dispatch on syntax within the one `Expression` AST."
    bullet, after "`NegateCard` ("Negative of") and `HereCard` ("Where you are now") are offered
    where the profile admits them", adds `CaseListSearchTextCard` ("Case list search text"),
    offered only where `SlotProfile.caseListSearchText` holds (§5.4);
  - `components/builder/CLAUDE.md`'s session-context sentence "New choices offer `userid`,
    `username`, `deviceid`, and `appversion`. Stored `drift` (Device clock offset), `window_width`
    (Window width), and `applanguage` (App language) appear as named read-only values" becomes "New
    choices offer all seven session fields, `drift` as Device clock offset, `window_width` as
    Window width (only where its slot profile admits it) and `applanguage` as App language";
  - the model-facing guide, `lib/agent/authoring/reference.ts`'s expressions text: "#search/name
    reads a Search answer in Search rules or that module's no-matches registration" becomes
    "#search/name reads a Search answer in Search rules, in the forms of a menu that opens on its
    search, and in that module's no-matches registration". This sentence and §6.5's context row are
    the guide text pull request 10 changes, held here (part 07 §3.4 places its pull request 12
    sentences after the context row, and part 07 §4 names these as this part's); both change under
    the same `MODEL_CONTEXT_VERSION`, `"v5-hq-round-trip-platforms.10"` (part 07 §3.9). Part 07
    §4's second `../nova-plugin` sweep, `rg -i "#search|search/|no-matches|stringquery|window_width|session/context"`
    over the plugin's `skills`, `agents` and `README.md` at `14af38e`, finds nothing, so no plugin
    text states the old claim; pull request 14 records it.
- **Pull request 11, builder** (part 07): the split gesture over `planDatetimeSplit`
  (`splitDatetimeQuestion`) and the insertion menu's "Date and time (as two questions)"
  (`addDatetimeAsTwoQuestions`) (part 07 §2.5, §2.6); `here()`, the case list search text and the context fields shown disabled with the reason
  where the declaration refuses them, through the item's rule admission (part 07 §2.5); the Search
  field note beside a `#search/` read (part 07 §2.8); the language-code picks for an `applanguage`
  comparison (part 07 §2.5).
- **Pull request 12, agent** (part 07): the `saDocs`, the guide with the split's sentence, the
  generated `here()` sentence and this part's search-text row (part 07 §3.4), and the pre-check
  returning part 01's `platformRefusalMessage` (part 07 §3.7).
- **Pull request 13, cutover**, consumes `planDatetimeSplits` through `planContentDeclaration`
  and §10's counts (part 09 §5, §6, §11).
- **Pull request 14, docs:** §3.2's public docs (`case-workspace.mdx`'s `here()` paragraph through
  part 07 §5's one merged edit), and `content/docs/building-with-nova.mdx` gains a
  short section "Asking for a date and a time separately" that tells the author what the split
  does, why Web Apps needs it and what changes for workers (§2.12), in the words part 10's "Public
  docs that change" row holds.

---

## Notes for later steps

The plan's own pull request writes these into the outlines:

- **`6-import.md`:** §2.14's sentence; the guarded reads of §6.3 and §5.3 read back as the bare
  read (`if(count(P) > 0, P, '')` and `if(count(P) > 0, P[1], '')` over the same `P`); a
  `current()/…` read inside a row predicate reads back as a field read spelled `current`.
- **`7-rest-of-model.md`, group 3:** Search field reads in the forms of a child module of a
  search-first parent.
- **`7-rest-of-model.md`, group 4:** `fingerprintquery` and
  `expressions-and-data/session-data-fingerprintquery`, with case-list callouts; the ordinary
  search's results-detail Search field read.

## Departures

Each departs from `docs/plans/hq-round-trip/4-platforms.md` or from the decision spine, with its
reason.

- **The outline's split** (the date question keeps the UUID, joined "by a datetime sibling") is
  replaced by design E (§2.1), and the outline's "the date-and-time question is the one held
  feature Web Apps cannot run" is false against the manifest: `here()` in a case list is the other
  (§3).
- **The outline's `DatumRef` kind for `stringquery` and `fingerprintquery`** is a value arm for
  `stringquery` alone (§5.2); `fingerprintquery` moves to step 7, group 4.
- **The search text prints `P[1]` inside the guard,** not `P`: one Android case list can leave its
  text on two frame steps (§5.1), where a bare read throws.
- **`window_width` is refused in every slot a form evaluates,** not only in form logic: case
  operations, form links and a lookup choice's filter are record slots CommCare evaluates on a form
  request, where the width is absent (§6.2).
- **The gate models Formplayer's `FormDef` cache** (§6.4): a cached form reads `''` where a fresh
  one throws, so the run has two arms.
- **Two targeted documents** hold the context reads (§9): `window_width` needs an app that does not
  declare Android and the search text one that declares only Android, so one document cannot hold
  both.
- **A Search field read stays refused in a form link's slots** of a search-first module's form
  (§4.2): the link evaluates in the suite's stack after the form, where no source in this plan
  shows the inputs are supplied.
- **Split identities take an attempt number** (§2.5), so a re-split after a partial manual undo
  still finds free UUIDs; attempt 0 keeps the computed identities.
- **App Tests and `evaluate_form` read the search text blank** (§5.4): neither drives a case
  list's filter box, and giving them one is a schema change no journey yet needs.

## Executed during planning

Nothing here was a paid call, a build, a test run or a lane run. The one production read was the
content-free scan of §10, which the person approved; no count from it enters this plan. Planning read
Nova at `e9e6cd93`, the Dimagi checkouts at the pins and `../nova-plugin`'s skills with `rg`. Two UUIDv5 computations gave
§2.5's identities, and a read of the corpus document `fuzz-suite-20260930-8` as emitted from
`main` gave its field (`model`, in a repeat, no `caseWrite` and no readers, `default_value`
`now()`, `label_media` with an image and a video).
