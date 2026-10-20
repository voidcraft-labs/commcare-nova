# Web Preview Engine

Client-side form preview running entirely from the in-memory blueprint, with no
XForm parsing. The non-writing authoring evaluator uses this same engine in a
bounded Node thread; it has no database or submission writer. Its observations
use the engine’s effective relevance through groups and repeats: an irrelevant
question is neither visible nor required and its old validation error does not
block the form. Computed hidden values remain inspectable with their field kind. Case-operation
answer bindings also apply effective relevance: excluded scalar reads are blank,
and excluded repeats have zero operation iterations. Retained input values are
not erased; they become available again when the question participates. Empty
nested scopes remain explicit so submission can distinguish them from stale input. Three subsystems own it: the XPath
evaluator, form engine, and preview UI. **Preview is part of valid by
construction.** Every XPath function, signature, path initializer, and instance
namespace Nova admits for a surface must execute faithfully in that surface's
Preview context and must emit faithfully to the owning CommCare runtime. The
capability tables keep independent runtime evidence, but they do not authorize
an authorable Preview subset. Adding an authorable capability therefore adds
its Preview implementation and its CommCare proof in the same change.

Hidden calculations retain their evaluated numeric and boolean types in the live
instance, entry checkpoints, and worker updates. UI/submission values remain text;
counts reading those nodes use Core's typed conversion without replaying calculations.

Calculated/default datetime answers retain the XPath Date's instant, including
hidden writers whose effective destination is datetime. Both synchronous and
worker evaluation use `FormEngine.computedFieldValue`; generic XPath string(Date)
remains date-only. Ordinary followup preloads still override defaults, including
when the stored property is blank. This does not change event-history policy.

Finite numeric calculated/default answers for `single_select` and `multi_select`
use the shared `numericAnswerText` after unpacking in
`FormEngine.computedFieldValue`. Generic XPath string conversion remains unchanged.

`regex()` and `replace()` target Formplayer's OpenJDK 17 `Pattern` contract,
which is the one stable CommCare host runtime. TeaVM compiles the pinned
OpenJDK sources to static JavaScript under `xpath/vendor/`; this is not native
JavaScript `RegExp` and not WebAssembly. User-authored patterns run only in the
bounded XPath worker because Java backtracking can be expensive. The JDK 17
character-name table for `\N{name}` is a separate lazy chunk. The finite,
reviewed patterns Nova generates itself may use the synchronous allowlist in
`generatedJavaRosaFunctions.ts`. The host timeout is a CPU watchdog, not a wall
clock limit on JavaRosa semantics: a worker `sleep()` pauses it while its
worker-owned timer is pending and resumes a fresh watchdog window afterward.
Cancellation terminates the worker generation out of band: a synchronously
backtracking Java Pattern call cannot consume an ordinary cancel message, so
settling its host Promise must never clear the only CPU bound while leaving the
worker alive.

`pow()` uses OpenJDK 17's portable fdlibm computation from that same generated
runtime. Java permits `Math.pow` implementations within one ulp, while TeaVM
normally lowers it to JavaScript `Math.pow`; V8 has produced adjacent doubles
across architectures. The explicit fdlibm path gives Preview one reproducible
result within JavaRosa's contract before OpenJDK 17 number-to-text formatting
sees it.

The provider owns that worker runtime through a re-armable `resume` / `suspend`
lifecycle. Effect cleanup terminates every worker and timer, but it never uses
the one-way terminal `dispose`: React Strict Mode replays cleanup and setup on
the same state-created controller in development, so the second setup must be
able to open a fresh generation.

A pending form activation retains its explicit search-answer snapshot while required case data loads or refreshes. Resuming that activation carries the same answers into `#search/` defaults.

Case-loading screens also wait for the selected record and its ancestor preloads
before starting an entry. Disabling input while those reads finish is insufficient:
one-time defaults and query-repeat membership must not run against absent context.
`useFormEngine` defers initial activation but owns its cleanup even when readiness
arrives later. An already active entry follows the rebuild/answer-retention
rules below during later context refreshes.

Search draft and submission commands live in `engine/searchRunState.ts`;
`hooks/useSearchInputRunState.ts` binds them to React. A standing search keeps
its submitted hidden values until the next submission or an authored hidden
input change. Prospective validation and the next submission resolve hidden
values against the latest identity and lookup data, even when authored input
shapes and visible defaults have not changed. Editing a draft preserves the
submitted map identity so it does not reload Results.
An admitted draft command preserves its input Map identity when no foreign keys
need filtering. SearchInputForm uses that identity to recognize its own debounced
acknowledgement; cloning it could overwrite a newer local answer with an older echo.

The Search screen has its OWN worker runtime beside the form's. A runtime
admits one active worker scope `(entryKey, profile)` and retires the active
scope when a different one arrives, so routing a Search prompt's `required` /
`validation` evaluation through the form runtime would retire a form's world
every time a worker typed on the Search screen. The provider therefore creates
a second `createBrowserXPathRuntime` and hands it to the controller as
`searchXPathRuntime`; `engineController.ts::evaluateSearchScreenXPath` requests
under `search:<moduleUuid>` with the `search` profile and the instances the
device's query screen holds (`xpathInstances.ts::searchScreenXPathInstances`):
the session, the draft answers as `search-input:results`, and the lookup
fixtures under their suite ids. The running Search screen's `session/data` is
the map of its module's case list step (`entrySessionData.ts::caseListStepSession`:
the datums supplied before the module's own selection, a parent selection or a
copied root datum from the menu case map, the worker's record and a grouped
tile's companion evaluated over the device's cases), which the screen's
defaults, hidden values, prompt checks and the search's runtime values all
read. The second runtime is needed because a user-authored
`matches-pattern` runs ONLY in the worker (the JDK `Pattern` runtime is
worker-only; the synchronous JavaRosa function table returns `unsupported` for
a user pattern). `engine/searchInputConstraints.ts` is the split:
`searchInputConstraintErrors` is synchronous and leaves a pattern-bearing
constraint unjudged (the server action does the same, so the sync path never
guesses), and `searchInputConstraintErrorsOnDevice` awaits the worker for those
constraints through the `evaluateOnDevice` callback `CaseListScreen` supplies.
Both judge `required.when` and `validation.rule` with the sibling answers
bound, blank for the unanswered, exactly as Core does.

The device-casedb readiness gate is committed in a layout effect. Descendant
form activation runs in passive effects, so the gate still arrives first, but
an interrupted or discarded render can never mutate the long-lived controller
with a snapshot or loading/error posture React did not commit.

An unsupported evaluation reached from a persisted document is an internal
invariant violation, never an ordinary historical-app state or a user repair
flow. Defensive containment must keep the Builder navigable, report the defect
through internal diagnostics, and avoid inventing a plausible result. That
backstop does not relax mutation admission, migration, or runtime parity: Nova
must continue supporting the stored expression or migrate it faithfully before
the old capability can be removed.

Value changes record `edited` synchronously, separately from blur's `touched`
validation state. Rebuilds preserve edited answers, including empty in-focus
values, without exposing validation before blur. Fields the person has left
alone still pick up new defaults. Same-entry rebuilds restore the full answer
world before reevaluation: existing repeat membership, query row attributes,
render identities, and the active section survive. Context recovery reruns
untouched defaults against those retained rows. Only pending section snapshots
recapture newly available context; consumed zero-row membership stays empty.
A language change retains all defaults as well as edited answers. This is
Nova context recovery, not a native repeat-insertion event. Rebuilds serialize
within the same entry, so a presentation refresh cannot discard later identity
or case-data recovery. Edits arriving during initialization catch up through the
ordinary topology, field and worker reconciliation handlers before entry is
ready; they do not replay an old checkpoint over the newer schema. Blur records touched state synchronously
before queuing worker validation. A
same-entry rebuild may retire that validation revision, but its snapshot must
retain the answer the person just committed, including an intentionally cleared
value. Never defer the ownership mark until the validation Promise settles.

While a same-entry replacement initializes, the controller retains the last
settled runtime publication, its naming document, path/page queries and repeat
render identities. Runtime field, membership and tree hooks select narrowly
from that document with field/tree equality; an unrelated edit must not
invalidate every field. Releasing the hold selects the current document on
the runtime publication even when no further document mutation occurs.
The paging decision and page/step field projections read this same retained
document, so an admitted section wrap or unwrap cannot retire controls before
the replacement publishes its new topology.
FormScreen keeps those controls mounted and inert until the replacement has
reconciled document edits and can publish its complete state. Overlapping
replacements retain the original settled presentation; they cannot restore an
unfinished candidate checkpoint. Mutation commands refuse during that window.
Deactivation, a different entry, explicit reset and runtime faults clear the
retained presentation, and retired initialization cannot revive it.

The `runtimeMessages.ts` platform catalog owns English/Spanish generic
required/type/constraint fallback messages, core worker navigation, live spoken
question/section/repeat positions and required markers, group/repeat controls,
datetime Date/Time names, and Nova-owned GPS address-search, wait/empty-state,
location guidance, browser-location failure and manual-coordinate copy.
Running-app menus, breadcrumb navigation, record lists and details also follow
the selected English/Spanish language. This includes filters, counts, selection,
paging, blank-value labels, loading and empty/error states. Authoring setup and
diagnostic guidance stay in English.

`WorkerDatePicker` shares selected-language calendar text and accessible
labels, placeholder and Clear across live forms and Search. The generic
`DatePicker` keeps English authoring defaults. Its display formatter receives the
canonical worker tag, retaining regional suffixes; DayPicker uses generic
English/Spanish labels and week layout. A language rerender adds no answer or
draft reset. Restored entries refresh existing invalid-state messages in the
new presentation language without touching previously clean questions. Capture
invalid paths before constraint settlement so an already-shown required warning
on a blank answer cannot disappear during restoration; revalidate current values
and rules rather than restoring stale error strings. Ordinary input blur still
commits and normalizes values. Other worker
languages
use English platform copy. Invalid Submit and section Next/jump feedback both
retain the `reviewHighlightedQuestion` intent and render it in the selected worker
language, including after a same-entry language change. Authored and server error
text remains literal. Browser geolocation failures carry typed reasons; the picker
resolves their catalog wording in the committed worker language at delivery,
after its existing Project and continuation fences. A language change does not
restart the request or change coordinate values. Google's map tiles, controls,
gestures, place names and resolved addresses retain Google's own language.
Clock formatting, record metadata,
media controls, other accessibility labels and diagnostics remain outside this
catalog; authored labels and custom validation continue through the app's
translation projection.

Read-only form and retained journey presentations use the same catalog for
repeat-instance headings and unnamed-question fallbacks. Pass the resolved
engine language to the presentation projection; an omitted or unconfigured
selection follows the engine's existing language resolution.

Custom validation wording uses the existing localized invalid-answer message
when its resolved wording is empty or a typed reference names several live
answers. Only the dedicated scalar-cardinality error or the worker's exact
evaluation/nodeset-cardinality reason enters this constraint-message policy.
Validation rules, ordinary labels/hints/help/choices, invalid paths, unsupported
functions, cancellation and all other runtime failures retain their normal
containment. This chooses no repeated row and joins no values; native
plain/Markdown constraint emission applies the same precise count guard, while
original media remains unchanged.

`useFormEngine` compares case-preload maps by their type/property/value content
before rebuilding. A list row and the later full case read may be separate Map
instances with identical values; that cold arrival must retain open controls,
focus and browser-local drafts. Changed values or ancestor additions still
rebuild the same entry, and confirmed scope changes still activate a new entry.
A selected record's complete required preload must be available before a fresh
entry accepts answers; an identical follow-up raw-row read may remain pending. The
form remains visible, but its controls are inert until the binding and engine are
ready; returning from a linked form must not expose a temporary blank preload.
A missing selected record is a terminal unavailable state with a route back to
record selection, never an indefinite loading or submission status.

Every displayed prose slot contributes answer dependencies, including help,
inline choice labels and validation messages. A question displaying its own
answer refreshes on input without adding a self dependency to the calculation
graph. Validation messages resolve their typed references when the rule fails.

A document topology edit refreshes the main instance template alongside the DAG.
Renames move answer keys first, then replace template metadata without reseeding
answers or repeat counts; worker snapshots must describe the same current paths
as printed references.

Each controller revision owns one worker evaluation world. Its first request
copies the main structure plus the engine-lifetime secondary snapshots; later
expressions reuse that world and carry only changed main-instance scalar
values and their expression-local context. No request carries hashtag values,
because no printed source holds a hashtag (worker protocol 8). A topology change reinitializes the
world. Repeat cardinality participates explicitly in that topology signature;
a zero-row bound repeat retains one dormant template subtree whose value keys
alone cannot distinguish it from a live row. Never restore recursive
per-expression instance snapshots: a form with many expressions over a large
casedb/fixture set must not clone that entire world once per expression.

Case and worker reads cross that worker boundary as the wire's own casedb walk
over the frozen snapshot: printed text the evaluator parses like any other,
never a value resolved before evaluation. They remain nodesets until the
evaluator applies JavaRosa coercion, so `count()`, `boolean()`, and other
node-aware functions observe the same identity and cardinality the device does.
A worker read prints a string literal of the identity's usercase value only
when the snapshot holds no `commcare-user` row for the worker
(`engine/workerExpressionBindings.ts::previewWorkerPropertyBinding`).

The casedb projection separates schema from cardinality. Dynamic property and
index names remain valid through template metadata, but an absent property or
index identifier is an empty nodeset and `count(...)` is zero; Preview never
materializes a blank synthetic element. Property text follows the declared
case-property type before it enters XPath, including Java `Double.toString`
lexical output for decimals (`0` is `0.0`). Index `@case_type` comes from the
type captured on the stored edge, not the target case's current type.
The device snapshot carries the stored schema's property types for every row
case type, including a type retired from the current blueprint. Stored types
win property by property while a blueprint retype awaits schema healing;
active materializable declarations fill properties absent from the stored
catalog. This prevents existing decimal/date JSON from silently changing XPath
text during either window.

The casedb load signal is structural:
`engine/expressionCaseReads.ts::expressionReadsCaseDatabase` loads the device
snapshot when a slot's tree holds a casedb `cases` query, a `project`, a
relation, a `form-case`, `prop`, `case-index`, `case-row-type` or
`owner-location-at-level` read, a worker-record `#user/` read, the
`usercase_id` or grouped-tile companion session datum (both evaluated over the
casedb when the entry begins), or a `repeat-row` of a query-bound repeat;
`useCaseDatabaseSnapshot.tsx` also loads it when a menu display condition reads
case data. The request carries the worker's claims. Typed case and worker references in prose labels,
hints, help and inline choices also require that snapshot, even when no XPath
slot reads a case. The scan uses the prose slot registry and typed parts;
literal hashtag text and answer-only references do not trigger a case load.
Query-bound repeats preserve each selected
node's lexical value across the worker boundary and seed it as the flattened
Preview row's `@id` (plus the zero-based model-iteration `@index`) before child
calculations run. Keeping only nodeset cardinality breaks the canonical
`current()/../@id` expression even though the repeat appears to have the right
number of rows. A scalar ids result follows Core's `DataUtil.splitOnSpaces`
exactly: only U+0020 runs separate ids, a leading empty id survives, and
trailing empty ids do not.

The structural world includes nodes the emitted form supplies even when Nova
has no value for them. The main `/data` root exposes the same `uiVersion`,
`version`, and `name` attributes as the XForm; `name` is the form's name in the
default language (`lib/domain/formWireName.ts::formWireName`). Preview's `version`
stays `1`: a submission's version is each export path's own counter (HQ's
form version on an HQ build, the app's sequence in a local archive), the
client engine also runs documents with unsaved edits, which have no
sequence, and a stored app test would change with every unrelated edit. The
`commcaresession/session/context` template uses the complete Core namespace,
including `drift`, `window_width`, and `applanguage`; an unavailable value is
an absent node, not an unknown path. `session/data` holds the entry's datums
(`engine/entrySessionData.ts::entrySessionData`), each valued as Core values it
when the session reaches it: a selection from the menu's case map; a `uuid()`
datum minted from the entry key by
`lib/domain/entryCaseIdentity.ts::entryDatumCaseId`, keyed by the case it names
(`new-case`, `new-child-case:<type>`) or, for a datum that names no case Nova
creates, `placeholder:<datum id>`; and `usercase_id` and `<datum>_parent_ids`,
evaluated over the entry's casedb snapshot. A datum Preview has no value for (a
several-case selection, which the batch form reads through its selected-cases
instance, or an inline search's query datum) is absent and reads blank, and an
unsaved app mints no ids. A registration form's read of its own case id reads
the `new-case` value, and the submission creates the case with that id.

Raw answer writes commit synchronously and remain in `pendingValuePaths` until
some current revision settles their cascade. Every successor revision first
reconciles those paths, so blur, validation, repeat changes, and submit cannot
retire an answer calculation and then observe stale state. User-controlled
repeat add/remove revisions are atomic within an entry: later browser events
queue behind topology mutation, defaults/cascade, and compaction publication.
Navigation may still retire the whole entry and discard its engine.

Home ends the current running task. It clears selected parent records, the current
Form/Details target, and transient search context while retaining the chosen worker,
actor authorization and the worker's claims, because a claim on HQ outlives the task. Reopening a related-record history therefore offers its
parent selection again, matching isolated app-test Home. Moving within a parent
menu still retains the parent needed by its children.

A required device-case database refresh pauses an existing entry without retiring
its answers, query membership or attachment entry key. New input, validation and
submission are refused until data is ready; the latest snapshot rebuilds the same
entry from its checkpoint. Cold activation still waits for real data. Deactivation
on navigation, worker replacement, confirmed app/Project change or access
revocation remains terminal and discards the old entry. A rebuilt runtime may
remount question controls; this does not claim preservation of focus or an open
native picker through a whole-database refresh.

The controller's asynchronous form and section validation return a completed
answer judgment or an unavailable/retired result. A completed judgment owns the
initiating engine, entry, lifecycle generation, device-resource state, document,
rebuild queue and worker revision. Consumers recheck that exact completion at
their continuation boundary; they never infer an invalid answer from readiness
or a later field snapshot. Only a current completed invalid judgment announces
and focuses its captured question. A refresh or replacement retires the original
Submit/Next/jump press without a write or automatic replay. Answers survive a
same-entry refresh, and a fresh press starts a fresh validation. The pure
FormEngine and non-writing form evaluator retain their boolean validation APIs.

Running navigation preserves the requested leaf across parent-case selection.
A direct Form or Results record that needs one or more case parents first visits
those selectors in case-type order, then replaces the selector with that exact
original location. Selector URLs are replace-driven and their ephemeral request
clears on cancel, browser Back, or unrelated navigation. Menu nesting never
implies case ancestry: the required selector comes from `CaseType.parent_type`
and may be a structurally unrelated module. Once selected, a direct same-type
child Form binds the exact inherited menu case; a different-type child lookup
is constrained by the selected parent and must never fall back to an
unfiltered first row. Direct Results records are checked against that same
parent before their detail is shown.

## First-class date type in the XPath evaluator

XPath values include a `XPathDate` alongside string/number/boolean. It holds its local calendar date (`calendarDays`) and, for a date and time, its instant (`timeMilliseconds`). `today()` returns a date, so `today() + 1` yields tomorrow, not `NaN`. CommCare's arithmetic converts dates to day numbers, and Preview's day number is Core's: `xpath/coreDays.ts::coreDaysSinceEpoch` and `coreDateAdd` compute it from the browser's zone as `DateUtils.daysSinceEpoch` and `dateAdd` do (the device-zone midnight of 1 January 1970, fixed 24-hour days, half-day rounding). The zone's offset is Java's, never the browser's own: `java.util.TimeZone` keeps a zone's history only from 1900-01-01T00:00Z and reads every earlier instant at the zone's current standard offset, so `lib/domain/javaZoneOffset.ts::javaZoneOffsetMs` gives the IANA offset from that instant on and the standard offset before it, and every Preview zone field (`coreDays.ts`, `instantDatetimeValue`, `format-date`'s `%Z`, a setvalue cast's clock, the offset a setvalue's uncast stamps, `string()` of a Date's zone name) reads through it rather than `Date`'s local getters, which follow the IANA history back into local mean time. Kiritimati's +14:00 before 1900 counts one day less there as well, and its clock steps back a day at the cutoff. That is a day off the calendar in `Pacific/Apia`, `Pacific/Enderbury`, `Pacific/Fakaofo`, `Pacific/Kiritimati` and `Pacific/Kwajalein`, as it is on a device. Numeric coercion of a date (`toNumeric`) and `date(<number>)` use it, `date(<number>)` truncating the number toward zero as Core's `toInt` does; a direct date in `toDouble` keeps its fractional days (`DateUtils.fractionalDaysSinceEpoch`, the wall clock), and `toISOString` keeps the calendar date, printed as `DateUtils.formatDate` prints it (the year unpadded). Calendar fields are Java's, `GregorianCalendar`'s: Julian before 1582-10-15 and Gregorian from it, both when fields become a day (`coreDays.ts::javaCalendarDays`, a date in the cutover's gap read as Julian) and when a day is read as fields (`javaCalendarDate`, the year counted in its era), so `format-date`, `format-date-for-calendar` and string coercion all print what Core prints. Core's `DateUtils.roundDate` is not the identity, and Preview runs it wherever Core does (`coreDays.ts::coreRoundDay`: every `daysSinceEpoch`, `dateAdd`, `date()` of a Date, a node's date in `format-date`, a calculated date): it reads `YEAR` without its era and sets it on an AD calendar, so a day before AD 1 folds to the AD date with the same fields (`number(date('0000-06-15'))` counts AD 1 June 15), and its proleptic Gregorian date check refuses a Julian February 29 in a year such as 100 or 1500. That refusal is Java's null: `date()` returns it as `runtimeValues.ts::XPathCoreNull`, which `coalesce` skips, `format-date` of a number or a node reads as no date, and every other read refuses (`types.ts::CoreUnroundableDateError`), as each read on a device throws. Day numbers are integer arithmetic on days, so every `int` Core accepts in `date(<number>)` has its date, past the range of a JavaScript `Date`; before 1900 a zone's offset is constant, so the far past is exact, and beyond the range's future edge the offset is the one at that edge (its final rule), which no zone's rounded day can tell apart. A date-and-time text beyond that range still has no instant in Preview and reads as no date. `date()` rounds a date and time to its local date whether it arrives directly or through a node (`coerce.ts::toDateRounding`, Core's `FunctionUtils.toDate`: a parsed string keeps its clock, `''` and NaN pass through). `format-date` and `format-date-for-calendar` keep a direct date's clock and round a node's (`expandDateSafe`), so `format-date(/data/dt, '%H')` is `00`, as on a device, and a blank node formats as `''`. `coerce.ts::toDate` keeps its name for the callers that read stored text and must not round. A datetime answer is read by the offset its canonical storage text carries, never re-resolved from wall time. A wall clock resolves as Java's `Calendar` resolves it (`coreDays.ts::javaWallInstant`): a repeated hour takes its later occurrence and a skipped one moves forward by the gap. `DateTimeData.uncast` stamps a date and time with `TimeZone.getOffset` of its local day (`coreDays.ts::javaOffsetMsOnDay`), which reads the day's midnight less the zone's raw offset as an instant and never resolves the wall clock, so Kiritimati's 1900-01-01 stamps +14 though its midnight there reads -10:29:20. A calculated date is held as the node's runtime value: a datetime bind keeps the instant, any other bind its date. The engine reads an answer by Core's type for its bind (a Hidden Value by its writer destination), never by its field kind alone. Every evaluation, synchronous or asynchronous, shares one parse cache per JavaScript realm (`evaluator.ts::parseAdmittedXPath`, 2,048 entries, keyed by the exact source). `lib/preview/xpath/__tests__/coreDateParity.test.ts` holds these rules to the fixture `proof/native/core/CoreDateParityRuntimeTest.java` holds Core to, in four device zones. Compatible typed emitters add the required wire coercion themselves. The experimental raw-XPath transpiler is not a production boundary and Preview must never assume that it ran.

Always use the shared XPath-to-string helper when stringifying results. Native `String()` on a date value gives `[object Object]`.

## Two `Child` / `Descendant` node types in the grammar

The Lezer grammar emits TWO distinct `Child` node types (one from the root-step rule, one from the expression rule) and likewise two `Descendant` types. `one('Child')` only finds the first. The evaluator uses `many('Child')` plus a `Set` / `.has()` check to catch both.

## Form engine lifecycle rules

- **Initialization actions run in authored scope and order.** Defaults and query snapshots run in document order; primary case preloads are appended last. Count-bound repeats read live counts after calculations and preloads settle, and again during entry and answer changes. Increasing a count inserts only new rows; decreasing it retains rows, answers, and case operations. Each write triggers dependent calculations and relevance changes before the next action, including reads affected by a hidden group. A loaded writer therefore ends with its case value, including blank, while an earlier snapshot can retain its default. Standalone calculations run after the actions. Inserting a repeat initializes only that new subtree, including its bound descendants, without recapturing earlier rows. Query identity attributes precede child initialization. Generated snapshot targets carry their enclosing row through the XPath worker even before a repeat has rows; they are expression-local contexts, never answer rows or saved data. Several-case forms preload no single selected record. Root-section query repeats retain their form-start membership; count-bound repeats refresh their target. Both defer insertion until that page is entered. Nested initialization then reads earlier-page answers. Entry checkpoints retain pending snapshots and the active page. Already inserted rows never recapture membership on Back/Next. Unsectioned Preview still presents the form together; no universal native question-by-question parity is claimed.

- **Required validation is deferred to submit.** Showing "required" on blur is bad UX because the user may have clicked in and navigated away. The red asterisk communicates requiredness until submission. Both synchronous and worker-backed blur obey this rule; a required warning already shown by submission remains until the answer changes.
- **Typed answers are checked before authored validation.** `answerShapeError` checks numeric and temporal answers on blur and at submission. Empty values belong to requiredness. Integer answers use signed decimal digits in the signed 32-bit range; decimal answers accept finite decimal and exponent notation. The numeric widget preserves incomplete text so an optional malformed answer cannot become an empty value through native input sanitization. Numeric case-write projection uses the same full-answer parser and never truncates a prefix. Temporal checks accept every spelling `isReadableTemporalValue` can canonicalize, including older stored values. Errors stay beside the owning question instead of surfacing later as a case-property refusal. Submit retains answer focus during a mouse press so blur validation cannot move the button out from under its release; activation then blurs the current control so local coordinate drafts and clock normalization commit before submission captures answers. A refusal reveals and focuses the first invalid question. Keyboard activation remains native.
- **A setvalue casts as Core casts, and refuses as Core refuses.** Every value Preview writes into a typed node outside a calculate (a case preload, a starting value, a repeat insert's defaults) goes through `engine/answerCast.ts`: `coreAnswerType` from the XForm emitter's own bind-type function (`lib/commcare/xform/bindType.ts::fieldBindType`, so a Hidden Value binds by its writer destination), `setvalueText` (`Recalculate.wrapData(...).uncast()`) and `castAnswerText`, the port of `SetValueAction`'s cast (decimals through `xpath/javaDouble.ts`, Java's `Double.parseDouble` grammar). Blank text never casts. A cast that succeeds stores Core's held text for a date and a date and time (the held instant's canonical text); a time keeps its written clock, because Nova's stored time carries a `Z` storage tag meaning UTC and holding the converted clock would move a saved time by the viewer's offset; a whole number and a number hold Core's held text, never the written one, because a later setvalue's uncast and the submission both carry it (`IntegerData`/`DecimalData` uncast, Java's print of the parsed value: `007` and `+7` hold `7`, `٧` holds `7`, `-0` into a whole number holds `0`; into a number `5` holds `5.0`, ` 1e3` holds `1000.0`, `0x1p3` holds `8.0`, `-0` holds `-0.0`); a location keeps the written text. One that fails at activation makes the entry `refused` (`EngineController.recordRefusal`): a terminal state beside the missing-selected-record state, with no controls and a route back (**Choose another record** and **Back to the list** for a preload, **Back** for a starting value), cleared when the document or the case data next changes. At a repeat insert the row is not added, and the repeat shows why in place; after the document changes (an edited starting value, or a rebuild restoring the entry) each user-controlled repeat's refused insert is tried again and rolled back, so the note stays only while the insert would still be refused. A refusal never reaches `faultReporter`. App Tests and `engine/evaluateForm.ts` report the same refusal as `FormRefusedError` (`form-refused`, a `FormEvaluationInputError`, with the sentence Preview shows). A calculate never casts, so it never refuses.
- **Default text remains text.** A default evaluating to `"false"` is a nonempty answer in both synchronous and worker execution; only the empty string means no default value. XPath numeric coercion and `selected()` use Java ASCII-control trimming, so nonbreaking spaces remain significant.
- **`reset()` is a full reinitialization** — rebuild instance, replay scoped initialization actions, re-cascade. Returns to the exact initial state.
- **`resetValidation()` clears touched state + errors only** — called when leaving test mode so fields start clean on re-entry.

### Two-state JSONB collapse for form completion

`computeSubmissionMutation` reads each leaf field's value via
`instance.get(fieldPath)` and filters on emptiness only
(`if (raw === undefined || raw === "") continue`); empty fields
are excluded from the emitted mutation, hidden fields with non-
empty values are NOT excluded. Properties whose value is empty
do not appear as keys in the mutation's `properties` object,
which means the case-store write omits them from the JSONB
document.

AJV's strict-mode constraints rule out the alternatives: `null`
fails `integer` / `number` types; `""` fails `format: date` /
`format: time` / `format: date-time` / the geopoint pattern.
Omission is the only shape that passes validation AND aligns
with Postgres missing-value semantics ("absent" ≡ "not present
in the JSONB document").

Case-write collection is not a second Preview model. `FormEngine` derives
`lib/domain/caseWriteInventory.ts` for its active form and immediately crosses
the shared `assertAndProjectCaseWriteInventory` boundary used by CommCare
lowering. That boundary admits the exact own/direct-child bucket membership and
forces every writer/repeat path through the private typed `FormPath` projection
once. Preview then materializes those admitted bucket objects against live
values: it trusts `bucket.kind`, carries the writer's explicit destination
property, and asserts that the runtime's nearest repeat UUID equals the
bucket's nearest repeat UUID before creating a concrete per-iteration child.
It never reclassifies primary/child membership from case-type text, field ids,
or rendered paths. The engine input uses `materializableCaseTypes(doc)`, so
writer-derived properties are typed without inventing a separate unknown-
property admission rule.

The standard writable scalars are a separate, explicit projection:
`case_name` and `external_id` never enter the JSONB `properties` object.
Preview routes them through the primary/child scalar slots that the submission
envelope maps to `cases.case_name` and `cases.external_id`. Both use the shared
Java `String.trim` boundary (only U+0000 through U+0020) and the 255 UTF-16-unit
limit. The form engine refuses a blank or over-long case name, and an over-long
external id, at the question a worker answers, reading
`lib/domain/caseScalarTextGuard.ts::caseScalarTextGuards`, as a device refuses
it from that question's own constraint, on the kinds
`caseScalarTextGuardIsChecked` names, the emitter's own predicate (a Hidden
Value source takes no such check). A case-destination edit that moves a guard
revalidates the answers it reaches. An active blank `case_name` is invalid; an active blank `external_id` is
a real `""` write that clears the value. A missing or irrelevant writer is no
intent and preserves the existing scalar. The primary destination in an
authored several-case form has one additional safeguard: a normalized blank
`case_name` or `external_id` is also no intent, because one shared blank must
not erase that scalar across every selected case. Child creation keeps the
ordinary scalar rules. When an ordinary field writer and a case operation both
target `external_id`, the ordinary form action runs last and wins, matching the
emitted CommCare transaction.

Form completion produces only 2 of the 3 spec-defined JSONB
states (absent / null / present-and-empty) — the
"present-and-empty" state is unreachable via any form completion
path. Other write paths (sample-data generator, direct API
writes) can still produce it. Consumers of `is-blank` should
read `lib/domain/expression/CLAUDE.md` § "Blank semantics: a locked invariant".

Every case-bearing submission lands through the case-store's atomic
envelope: `submitFormAction` projects the engine's `SubmissionMutation`
onto `CaseStore.applySubmission` (`submissionEnvelopeArgs` in the
binding helpers), which applies the primary write, every child insert,
and close's lifecycle transition in ONE Postgres transaction — partial
success is unobservable, and the running-app view re-queries one
settled state on resolve. Every mutation arm carries the form UUID,
controller-owned entry UUID, and exact attachment-reference projection
(including an explicit empty list), plus plain-JSON per-scope operation
answer bindings when the committed form has operations
(`computeOperationAnswers` — complete per iteration, parent-major,
multi-select as token arrays). The Server Action validates and normalizes
that final protocol before program, capture-intent, or effect derivation; the
retired name-only projection is rejected. Its authorization transaction locks
the app, proves fresh Project membership, and reads any durable receipt before
loading blueprint topology. Before the request, Preview flushes the reconciler's
human-save barrier and hashes the exact persistable submit-time blueprint over
canonical JSON. The action compares that digest with its locked committed app
before deriving a new submission program; a save or collaborator race returns
the typed `blueprint-changed` refusal. Every newly accepted receipt persists
that exact blueprint digest with its transaction result. An exact retry still
replays its saved effects after later edits, but it returns routeable success
only when the receipt digest matches the client's rendering revision;
historical or mismatched receipts report that the answers were saved and ask
for a reload instead of evaluating today's after-submit topology. The SERVER builds
the case-operation program from the COMMITTED doc
(`buildSubmissionOperationProgram`: the shared `lib/doc/caseOperationOrder.ts`
analyses + `buildCaseTypeMap` + the
identity's session values, `ordinary.caseType` populated for the rolling
proof). Even when the form has no advanced operations, that build projects each
ordinary child's committed case-type relationship; the client never asserts
`child` versus `extension`, and the envelope persists the same `parent` index
relationship the XForm emits. That same authorized boundary retains the `LookupScope`, projects the
canonical production lookup occurrences onto the built program's operation
UUIDs, and loads one rows-free definition snapshot only when those operations
actually carry lookup references. The resulting `lookupTableSchemas` map is
part of the immutable program handed to `applySubmission`, so a schema-heal
retry reuses the exact same compiler context; lookup rows themselves stay
current inside the submission transaction. A committed operation-bearing form
with missing answer bags rejects wholesale rather than silently applying
ordinary-only effects. A survey with a program executes it, and the envelope's
typed `SubmissionRejectedError` surfaces as the
`submission-rejected` result arm with whole-rollback copy in
`FormScreen`. The close transition itself stays the
store's: it atomically owns both `closed_on` and the canonical
built-in `status = "closed"`; the preview must never supply or invent
its own status vocabulary. This keeps the live row aligned with
CommCare's `@status` attribute and makes a close form with no property
writes a complete lifecycle write by itself.

## Attachments are staged per form entry, reserved atomically at submit

A capture question's answer is a server-minted attachment name; the bytes go
straight to GCS on a signed URL (`components/preview/form/fields/attachment`),
never through a Server Action — a `File` argument would make React encode
multipart, which the edge WAF reads as header injection.

`EngineController.entryKey` is the idempotency/reservation scope, minted per
`activateForm`. It lives on the CONTROLLER, not the engine, and survives cold
identity, lookup, case-data rebuilds, and an access refresh confirmed for the
same Project; a key minted by each rebuilt engine or scope epoch would rotate
under already staged bytes. A confirmed app/form/Project change, materially
different worker projection, terminal revoke/upgrade boundary, or **Clear
form** retires the entry and rotates the key. Clear mounts the fresh answer
world synchronously; deletion of the retired entry's staging rows is
best-effort and never delays or later resets the new entry. **There is no form
resume** — nothing persists
runtime answers and `deactivate` wipes the store — so leaving a form starts a
new entry. The controller exposes that identity through `entryStore`; form
lifecycle code must subscribe to it rather than sampling the imperative getter,
because a materially changed worker projection can rotate the entry from a
provider effect without changing the persona UUID or route. The key also names
the cases the entry creates: a registration's primary case and each child a
one-case form creates outside a repeat take `entryDatumCaseId(appId, entryKey,
…)`, so an exact retry derives the same ids and **Clear form** mints new ones.

Confirmed row ownership lives at `(app, entryKey, stableSlotKey)` above any one
rendered field. A stable slot is the field UUID plus every enclosing repeat's
stable instance identity; its concrete indexed path is a mutable projection.
Relevance, group/repeat remounts, Preview/Edit flips, and positional repeat
compaction therefore cannot delete or misidentify an answer whose entry is still
live. The same slot retains its filename, recoverable issue, and signature draft
above component lifetime. A real entry teardown/reset best-effort deletes those
unreserved rows immediately; the scheduled row sweep and staging TTL remain the
failure backstop. Every cleanup DELETE — teardown, replacement, remove, repeat
deletion, or post-initiate PUT/confirm compensation — is bounded and detached
from the entry queue. It can leave an expiring orphan but cannot delay an answer
commit, confirmed replacement, or Submit. Initiate, signed PUT, confirm, and
retarget each own a foreground deadline covering the request plus its
success/error response body. Cancel aborts the current slot generation without
changing its prior confirmed owner; a late completion is fenced and cleaned up.
That absence of cross-entry resume is
also why nothing simulates
the runtime's blank-pad-over-live-signature behavior: the state cannot arise
here. A future resume story must carry the entry key forward with the answers,
and must leave the pad blank rather than helpfully restoring it.

`FormEngine.collectAttachmentReferences` carries the exact server-minted name,
field UUID, and concrete repeat-indexed path for every surviving answer, and it
DOES consult effective visibility (the field plus every group/repeat ancestor)
— unlike the case-property collector, whose
visibility-blindness is an AJV storage constraint with nothing to say about
attachments. The server re-derives the committed field/path templates and
rejects stale or mismatched provenance. An irrelevant question's node is
omitted from the submitted instance on the wire, so its attachment is genuinely
not part of the submission. Nova then diverges from the platform by not
shipping it at all, where the real runtime enumerates the session media
directory and uploads orphans anyway.
An empty attachment projection from a committed form that still contains a
capture question nevertheless emits `captureIntent` with `attachments: []`.
That keeps a retry under the same entry key inside the durable receipt/digest
protocol after an earlier accepted request, instead of letting cleared, hidden,
or removed answers bypass replay and repeat case effects. The submission
envelope also carries that receipt identity independently of `captureIntent`.
The action's one authorization transaction reads an existing durable receipt
before current blueprint/form/capture validation; when no receipt exists it
returns the committed app snapshot used for program and capture-authority
derivation. The preparation transaction and entry-locked store reauthorize at
their own mutation boundaries and adjudicate the receipt before effects, so an
exact retry after the form or capture question is deleted still replays and a
changed digest rejects before effects.

Confirmed capture completion joins the controller's readiness work, never its
own attachment queue, before staging the answer. It resolves the current path
from the captured field UUID/kind and each enclosing repeat's typed UUID and
stable instance key. A removed row, changed capture kind, hidden slot, retired
entry, canceled task or runtime fault cannot accept the answer. Ownership
adoption runs synchronously after actual answer staging is acknowledged;
confirmation alone is insufficient. Confirmed rows that never reach adoption
are cleaned even when acceptance throws. Answer Clear uses this same boundary
before releasing ownership or scheduling byte cleanup.

Every capture mutation for one entry goes through one form-wide queue. A newer
operation aborts and generation-fences an older operation on the same stable
slot. The control publishes queued intent before it waits behind another slot,
so a second picker/clear/draw gesture cannot silently supersede the first;
signature debounce and `toBlob` encoding enter that queue immediately,
and a dirty/failed encoding keeps the barrier blocked rather than submitting
an older answer. `pointercancel` and `lostpointercapture` settle the ink through
the same path; dirty stable draft state starts an immediate encode after an
ordinary remount. A
signature Clear during queued/active save is itself the newer explicit intent:
it aborts that generation and queues exactly one answer-clear transition. Its
private serialization key carries the real stable slot/path/field target, so
Submit classifies and waits for that active clear rather than mistaking the
synthetic key for a deleted engine path. Dormancy cancels an older signal-aware
upload/retarget but does not cancel this explicit Clear: it runs ahead of Submit
so the old answer cannot revive later.
Submit first classifies every registered, active, not-ready, and retargeting
slot **before** it joins the tail; it continues classification while waiting.
Dormant work is aborted without dropping its draft/issue, removed work is
retired, and only active `notReady` state can reject. Retarget PATCH maintenance
is signal-aware and registered by slot too — otherwise an offline PATCH for a
now-hidden question could starve the barrier it sits ahead of. Submit remains a
barrier behind participating prior work and ahead of later work, and rechecks the
initiating form, entry, persona, case, Project scope, and post-submit
destination before calling the action. Once Submit enters `running`, the
entire answer surface is inert/disabled until the barrier and server action
settle; a post-click text,
picker, signature, repeat, replace, or remove gesture cannot join only one side
of the submission snapshot. Clear form does not use this barrier; it retires the
old entry and synchronously mounts a new idempotency scope.
A confirmed owner whose retarget is cancelled by dormancy keeps a stable
retarget blocker and a suspended marker. If the question becomes active again,
the next barrier mints a newer generation and repairs/converges that owner
before submission; a late cancelled response cannot clear the newer blocker.
A real non-abort retarget failure is marked failed and never auto-retries from
barrier polling — the worker still chooses Retry, replacement, or removal.

`EngineController.removeRepeat` is the ONE compaction owner. It emits the
removed prefix plus every positional move; FormScreen binds that event to the
entry coordinator even when the affected capture is irrelevant/unmounted.
Remove remains visible but disabled without current write authority. Its
imperative boundary requires the exact coordinator authority generation
captured by the handler, then rechecks the controller entry key and target
repeat instance's stable key immediately before compaction. A handler captured
before refresh, viewer downgrade, or authority loss/restoration cannot retire a
successor instance or its capture. The
coordinator updates desired slot paths synchronously, queues server CAS
retargets after any already-running upload/encoding and before Submit, and
cancels/discards only slots belonging to the removed instance. A failed old
retarget NEVER clears the answer or discards the retained row. It preserves the
owned attachment, desired and server paths, filename/signature ink, and a
generation-tagged `notReady` issue. A picked-file save failure also writes that
stable slot issue instead of component-local state, so **Choose file** recovery
survives an ordinary remount. Retarget failure exposes Retry plus
replace/remove for picked files; Signature exposes Retry beside the pad's single
**Clear signature** action, and its message names that exact action. Recovery
controls have question-qualified accessible names. Retry CASes the retained
row; a newer replacement generation supersedes it and clears only the older
issue. A surviving pending signature keeps its draft and `notReady` blocker
until its latest PNG confirms, then the newly owned row—not an older PNG—is
retargeted.

Authored path changes use the same ownership lane. One whole-batch
`EngineController` topology subscription compares the complete pre/post
UUID-to-path projections and moves every retained engine value in one atomic
call before per-field listeners run. It emits one capture-move set by stable
field UUID for simultaneous capture renames, cross-parent leaf/subtree moves,
ancestor renames, and group↔repeat conversion; the coordinator remaps every
concrete instance path synchronously and serializes its row CAS behind any
in-flight upload and ahead of Submit. Each retained/deleted event carries the
pre/post stable identity of every path segment, so retained repeat indices
survive cross-parent and different-depth moves instead of following positional
depth by accident. Projection is tri-state: mapped paths retarget, only a
proven removed repeat instance or an explicit deleted-field variant may clean
up, and malformed/missing identities preserve owner, picked file, signature
ink, and an invariant Submit blocker. The stored old path is only the CAS
coordinate—the destination alone must match the current committed capture
template. When malformed topology leaves no valid rendered path, the form owns
a recovery-only, question-qualified action that can remove the file or clear
the signature without claiming a new path; Submit focuses that action. A stable
UUID's explicit deleted-field event takes precedence over an unusable old-path
projection and retires exactly that slot. A capture-kind change
is incompatible ownership: cancel/fence active work, clean the old row, and
retain a targeted replacement blocker on the stable field UUID. React remounts
recover the existing slot by `(field UUID, desired concrete path)` so a
group↔repeat renderer-key change cannot create a second owner.

Project viewers may inspect capture answers but must never mint or mutate
capture data. Controls disable picker, drawing, clear/remove, and recovery
actions; authority loss aborts and generation-fences work already in flight.
`FormScreen` installs one exact coordinator authority token containing
`appId`, `entryKey`, `formUuid`, `projectId`, `actorUserId`, `ownerId`,
`scopeEpoch`, `accessPhase`, and `canEdit`. Every operation also carries its
exact stable slot key. Missing/stale authority, missing slot identity, missing
response-body methods, and malformed response coordinates reject in production;
tests must supply the real contract rather than activate fallbacks. Form-level
invariant recovery uses the same exact coordinator authority token:
its Remove/Clear control disables during refresh or viewer access, and
imperative discard rejects a missing or stale generation before retiring the
owner, retained File/signature ink, and Submit blocker.
Every event handler re-reads the current session access tuple at its mutation
boundary, just like Submit and Clear form. A transient refresh suspends old
network generations but preserves the controller, entry key, answers, focus,
browser-owned File controls, staged ownership, drafts, ink, diagnostics, and
Submit blockers. If React batches the refresh and same-Project authorization
into one committed render, the authority generation still pauses active file
drafts and rearms dirty signature ink exactly once.

Signature pixels are entry/stable-slot-local across ordinary remounts and reset
on an entry/persona change. Points are normalized to the canvas bounds, so a
successful encoding records CSS width/height, device pixel ratio, and backing
width/height beside the strokes. CSS resize, DPR-only change, and a remount at
different geometry redraw and re-encode the complete signature rather than
clipping old absolute coordinates or submitting stale pixels. `toBlob`
callbacks also carry a generation fence because the browser API cannot itself
be aborted. Encode/upload failure retains the ink plus an actionable
Retry/**Clear signature** slot issue across remounts; Retry re-encodes the
retained strokes.
The DPR watcher is a self-rearming resolution media query, so a density-only
change does not depend on a window resize event. Clear's inverse stroke buffer
is stable-slot state, so Undo survives ordinary remounts until the worker draws
again. A blocked canvas exposes its disabled/read-only state to assistive
technology.

`FormEngine.firstInvalidFieldTarget` returns the first effectively visible
invalid concrete path plus every structural ancestor UUID. On invalid Submit,
`FormScreen` expands those group/repeat ancestors in one layout commit, announces
the failure, then scrolls and focuses the real invalid control (`input`,
signature canvas/custom textbox, button, or the focusable question wrapper
fallback). Collapse toggles carry `aria-expanded` and `aria-controls`; selected
capture questions use the same custom-control-aware focus selector.
`AttachmentNotReadyError` carries stable slot, concrete path, and field UUID;
the same reveal path opens a collapsed blocker and focuses its exact Retry
action. Both paths use immediate scrolling when reduced motion is requested.

## Sections page the preview on Android's rules

A sectioned form (root sections only, `lib/doc/formSectionVerdicts.ts`) previews one page per section, because that is what the wire's `appearance="field-list"` group is on a phone: one screen per section, Next validating the screen before it turns, Back never validating, an empty or all-irrelevant screen skipped. Default Web Apps shows the same form as titled groups on one page; the preview follows the device and the docs say so. A form with no sections is untouched.

- **The engine owns the page model**: `FormEngine.sectionPages()` (root sections in order, each with its `/data/<id>` path, current question visibility and any pending row insertion), `validateSection(uuid)` (`validateAll` restricted to the paths under that section, marking them touched) and `firstInvalidFieldTarget({ withinSection })` (the same target, with the section leading `ancestorUuids`). The controller mirrors all three; `hooks/useSectionPages.ts` subscribes through a one-string key so a keystroke does not re-render the pager.
- **The open page is session state**, `activeSectionByForm` (`lib/session`), shared with the edit canvas so a flip keeps the page. `components/preview/form/sections/useSectionPaging.ts` arbitrates: the remembered page while it is visible, re-anchored (`engine/sectionPaging.ts::resolveCurrentPage`) and written back when it empties; `goNext` validates the current page and on failure announces through the form's `role="alert"` node and reveals the first invalid question on that page; a forward `goTo` validates every page between; `showPage` turns with no check, which is what Submit routing (the earliest invalid page, `ancestorUuids[0]`) and Clear form (the first page) use. Enter never advances.
- **`FormScreen` renders `SectionPage`** (the shared `SectionHeading` as a focusable `h2` the page is labelled by, over `InteractiveFormRenderer` rooted at the section, so every question reads and writes the same paths as on one page) in place of `FormRenderer` while paging, and the bottom bar carries the `SectionStepper` (`nav aria-label="Sections"`, `aria-current="step"`, a polite "Section k of n: title" after a user-driven turn) plus Back / Next, with Submit taking Next's place on the last visible page. The invalid-submit and attachment-not-ready arms turn to the question's page before the ordinary two-frame reveal.

Page announcements and pending heading focus belong to the actual controller
entry and visible page, not the retained FormScreen. `showPage`, `showFirst`,
automatic re-anchoring and entry retirement clear the old turn intent. Navigation
checks entry ownership after every asynchronous entry/validation step; a retired
or superseded continuation cannot move the page, announce or focus a question in
the new entry. Ordinary turns still focus and announce each time, and a same-entry
language change retains the current announcement in its new presentation language.

## Repeat instances are first-class

Repeat children live at CONCRETE indexed paths (`/data/orders[1]/name`), one FieldState per live instance. Authored expressions retain UUID-based node identities. `formExpressionRuntime` lowers them through `toWire` using their actual slot context and the private Preview form-node projection; `formReads` maps the same identities to index-free dependency paths. `instancePaths.ts` bridges those paths to live instances:

- **Evaluation binds to the instance.** `createEvalContext` rebases absolute `/data/` reads (the `preview` print of a `#form/` read is one) onto the evaluating node's own repeat instance by longest-common-repeat-prefix (`rebaseOntoContext`), CommCare's relative-reference semantic. A relative read (`../`, `current()/`) evaluates from the context node itself. A reference from OUTSIDE a repeat to children inside it materializes the complete nodeset for node-aware functions, predicates, and Core-compatible scalar coercion; it must never collapse to one guessed value or blank merely because Preview is evaluating it.
- **The TriggerDag topology is index-free; queries materialize.** Nodes and edges are keyed by generic paths, and `getAffected` / `getAllPaths` fan each generic node out over the live instance counts (a `RepeatCountResolver` the engine supplies). Repeat add/remove therefore needs NO DAG bookkeeping; both cardinality changes re-evaluate EVERY instance (`position()` and renumbered sibling reads can shift on removal) plus outside dependents, and `addRepeat` runs defaults-then-evaluate for the new instance, the same order as form load.
- **Authoring cycle proof is a strict superset of runtime triggers.**
  `TriggerDag.reportCycles` also rejects live count feedback through count expressions, calculations, and repeat descendants. A count cannot depend on rows it creates: Core parses that loop but entry can keep creating rows indefinitely.
  It temporarily adds these other kinds of authoring-only
  edge: field-DEFAULT dependencies, so validation can reject loops through
  defaults (`build` / `rebuild` exclude them because defaults apply once
  during initialization), and the RELEVANCE CASCADE from a group or repeat
  to every descendant, because the device re-triggers everything inside a
  container when its display condition changes (`commcare-core
  .../FormDef.java::fillTriggeredElements` over
  `Condition.java::isCascadingToChildren`), so a container whose condition
  reads its own contents is "Logic is cyclical" at install and CommCare HQ
  refuses the build. Runtime includes that cascade as well: a descendant's
  changed relevance can change the value a structural read observes.
  Each report names the cascade edge it closed through (`CycleReport.cascade`)
  so the validator can explain the containment, which no authored expression
  spells out. Reads name exact addressed nodes, never every navigation prefix.
  Native cycle collection uses the complete finite graph, including query
  wrappers and generated count/Connect calculations, and keeps cascading
  self edges. Runtime scheduling keeps its existing settle-free handling of
  presentation and validation reads.
  Lookup-choice filter dependencies are RUNTIME edges (the `choices`
  expression below) — the proof sees them through the ordinary collection,
  not the swap. Required metadata is also outside the value-cycle proof:
  `XFormParser.java` registers its `Condition`, but `Condition.canCascade`
  returns false for `ACTION_REQUIRE`, so `FormDef.fillTriggeredElements`
  adds no outgoing ordering edge. Required reads, including self-reads, are
  collected as metadata dependencies. Each runtime pass settles affected
  values and relevance first, then refreshes required flags; a required
  change never propagates as an answer change or displaces a calculate edge.
  A field's constraint (`validate`) and its label/hint `<output>` references
  are absent from the proof too: they are evaluated on demand and never
  registered as triggerables. A loop that closes only through required,
  a constraint or a label therefore installs and runs.
  The runtime keeps those edges (validation re-runs and labels re-render
  when their inputs change) but adds them LAST and only where they close
  no loop (`addSettleFreeEdges`), so a loop through one of them drops that
  edge and never a calculate or relevance edge.
- **Instance counts are explicit.** `DataInstance` tracks cardinality in its own map, keyed by concrete repeat path — never derived from which value keys happen to exist (a repeat with only structural children still counts 1). `set` auto-extends counts from indexed path segments so restore/rename flows stay consistent. A new instance seeds the AUTHORED template shape — nested repeats restart at one instance, matching what the deployed form's `jr:template` produces — not `[0]`'s live shape.
- **Count-bound repeats follow the emitted carrier.** A bare integer question reference in `jr:count` is read from that node through JavaRosa's `IntegerData.cast`: blank means zero, while every nonblank value must be an exact base-10 Java `int` lexical value (`2.0` and `2.5` are errors, not two rows). Hidden-value references and other expressions are different because the emitter calculates it in Nova's generated `xsd:int` node; Preview retains that node's numeric coercion before materializing the count. Both synchronous and worker execution use this same split.
- **The runtime store is dual-keyed.** Every field keeps its uuid key (edit-mode rows); every path with an `[N]` segment ALSO gets a path key — the interactive renderer subscribes via `useEngineStateAt(uuid, path)` and writes through `controller.setValueAt(path, …)` / `touchAt(path)`, so two instances of one field hold independent value/visibility/validity. Uuid-keyed flows (`onValueChange`) address the `[0]` template only.
- **Doc mutations land on every live instance.** The controller's incremental handlers (field added / removed / retyped / expression edited during live preview) route through the engine's instance-aware ops. Authored topology is reconciled once per committed batch from complete pre/post path maps, so two independent renames or a cross-parent subtree move cannot observe a half-updated map. `materializePaths` expands the uuid map's `[0]` template path over the live counts, and `renamePaths` moves all values/states in one call (materialize-before-move, since renaming or moving a repeat container relocates the count its descendants materialize through). A repeat→group conversion keeps only instance 0; the other instances' values are dropped with their states unplugged.

In render paths, read repeat instance counts from `state.repeatCount` (via the engine-state hooks), not from `controller.getRepeatCount(uuid)` — the latter is a non-reactive method call. `addRepeat` / `removeRepeat` bump `repeatCount` on the repeat's own `FieldState` precisely to give subscribers that signal. `getRepeatCount` is fine outside render or in render paths whose lifecycle guarantees no add/remove can happen while mounted (e.g. edit-mode-only rows).

## One printing path for every surface, one lookup snapshot

`FormEngineInput` carries the real `BlueprintDoc` and form UUID.
`formExpressionRuntime` reads the stored slot directly; authoring display text
never becomes evaluator input. The current Preview instance keeps query rows
at its existing flat paths through a private projection. Unsupported generated
node reads fail explicitly until that instance represents them. Native export
and cycle admission always use the complete native projection.

Bulk Search evaluation carries `{ doc, moduleUuid, lookup }` and derives a
separate context for every prompt's default, hidden value, condition or lookup
filter. A single-expression helper requires that expression's own context.
A table lookup's nested filter obtains its lexical row context from the typed
expression path, rather than inheriting a caller's case-type bag.

Preview never grows a second interpreter and never rewrites an expression
into a value before printing it. Every surface (form logic, prose outputs,
Connect, form links, navigation display conditions, Search defaults, hidden
values, conditions and checks, lookup filters, case-backed choices) builds its
slot's wire tree with the one device emitter, `toWire(expression, { target:
"preview" })` with its actual slot-derived `ExpressionContext`, prints it with
`serializeWire(tree, { target: "preview" })`, and evaluates the printed text
with Preview's evaluator over instances shaped like the device's. A label or
hint reference prints the same way, as the XForm's `<output>` for it reads
(`labelRefs.ts`). The Preview target differs from the wire in one addressing
rule: a query-bound repeat's flattened rows carry `@id` / `@index` and have no
`item` step (`formExpressionRuntime.ts::previewFormNodeProjection`). Every
lowering is therefore the same code in Preview and on the wire. A form
runtime prints each slot once and holds the text for its own life
(`formExpressionRuntime`); the text depends on the runtime's bindings, so the
memo belongs to the runtime, never to the document. A lookup-backed choice
list prints the wire's nodeset (`lib/commcare/lookupOptions.ts::lookupOptionsNodeset`,
shared with the XForm itemset and the Search prompt) and evaluates as Core
evaluates the itemset, over the fixture instance built under each table's
XForm id (`lookupEvaluation.ts` reads each selected row node back as its row).
A `table-lookup` prints the wire's `instance('<tag>')/<tag>_list/<tag>[…]`
read: a no-match is Core's empty node-set, and missing and stored-empty cells
both read blank, the fixture boundary's semantics. Form logic reads a table
under its bare tag. A form-link slot also reads it under `item-list:<tag>`,
the id the suite declares (`includeFixtureAliases`).

Data is ONE Project fixture snapshot (definitions + complete ordered rows for
the doc's referenced tables): `PreviewLookupDataProvider` fetches it
generation-keyed on the reconciler scope epoch, refreshes per-table on the
Project lookup clock, and installs it on the `EngineController` like the
preview identity. **COVERAGE, not presence, decides evaluability**: the
snapshot covers only the tables referenced at fetch time, so every surface
asks the coverage predicates (`lookupOptionsSourceCovered` /
`predicateLookupsCovered` / `expressionLookupsCovered`) first and treats a
miss as its loading state — a validly committed edit referencing a
new table/column degrades gracefully while the refetch lands, and the
`requireTable`/`requireColumn` throws fire only on a genuinely bypassed
validator. An engine CAPTURES the snapshot at activation — choices stay
stable within a form session (the wire's install/upgrade fixture semantic)
and the next activation picks up the refreshed cache; an arrival rebuilds the
active engine only while its capture fails to COVER the form's carriers
(cold load, or a valid rebind the capture predates), with edited and touched values
restored. Choices are engine values: the DAG's `choices` expression
re-filters on any filter-answer change (the device's prompt-rebuild), and a
selected value the rebuilt choices no longer offer is unselected (token-wise
for multi-select), cascading through the ordinary topo pass.
`FieldState.choices === undefined` is the typed loading state, and each
choice carries its source row id as display identity (lookup rows guarantee
neither unique nor non-blank values). The predicates take form-logic and
form-link carriers too: `lookupEvaluation.ts::formLogicLookupsCovered` asks
`expressionLookupsCovered` of every expression slot of the form, its
questions, Connect block and links (`expressionSlotValues`), and
`formEngine.ts::lookupDataCoversForm` adds it to the choice sources. Printing
such a read needs the table's naming, so `EngineController` holds back an
entry whose logic reads a table the snapshot does not cover, and
`setLookupData` starts that entry once a covering snapshot arrives. A
same-entry rebuild that has to wait (an edit added an uncovered read
mid-entry) keeps its entry key and the checkpoint it began with, and the
covering snapshot resumes that entry with its answers; opening the form again
while it waits starts a fresh entry instead. While it waits the controller
watches the document, so an edit that removes the uncovered read (or the
form) starts or resumes the entry without a new snapshot, and
`EngineEntryState.lookupWait` says why it waits: `loading`; `error` when the
lookup load failed (`setLookupLoadFailed`, from `useLookupPreviewData.tsx`),
which `FormScreen` offers to try again (`usePreviewLookupReload`); or
`unavailable` when a snapshot read for exactly the tables the document
references (`setLookupData`'s `requestedTableIds`) still lacks one, which
`FormScreen` sends back to Edit. The provider compares snapshots by Project
revision and the tables read, since an edit that reads one more unchanged
table reads a snapshot at the same revision. `engineControllerLookupWait.test.ts`
holds these paths.

Navigation display conditions (`displayConditionEvaluation.ts`) evaluate at
render through the same printing path: module conditions gate the home
screen's module list; form conditions gate the case-list screen's
post-selection form menu + single-form auto-continue (over the device
snapshot, reading the chosen case through the suite's own casedb walk keyed on
`session/data/<datum>`, with the same suite emitters `compiler.ts` writes the
attributes with; the menu's session also holds the case list step's map, so
`chosen-case(<parent menu>)` reads the parent menu's datum under the id the
form's entry prints it, `entryDatumIdResolver`) and the module screen's
forms-first list. A condition that
reads case data is `pending` until the snapshot covers it. Raw absent-node semantics hold — absent
string-unpacks to `""`, numeric ordering yields NaN, no presence guards.
Visibility is three-valued: a carrier-bearing condition without loaded data
is `pending` (placeholder, never a guess); hidden items surface through the
ghosted "Hidden items (N)" reveal with `summarizeFilter` summaries; edit
mode never hides. A condition is evaluated as stored
(`displayConditionForEmission`): nothing inside it is absorbed, so
`x and never` still waits for `x`'s data.

An item off the menu (`hiddenFromMenu`) is `hidden` before its condition is
read, and a module off the menu takes its child modules off with it, as on
both runtimes; its reveal summary reads "Off the menu" (`menuProjection.ts::
OFF_THE_MENU_SUMMARY`). App Tests cannot open one from a menu. Preview plays one
runtime per behavior until it plays each platform: after-submit routing opens a
link's target whatever its visibility (Android), and an entry point opens a
form off the menu only when it ignores display conditions (Web Apps), with
`entryPointLaunch.ts::FORM_OFF_THE_MENU_ENTRY_POINT_REFUSAL` saying what each
platform does otherwise. `firstMenu` resolves to the same home screen as
`app_home` (Web Apps shows the app's first screen for both), and `parentMenu`
to the parent module's screen with its selection kept.

## Value persistence across engine recreation

Blueprint mutations in edit mode recreate the engine. The engine hook snapshots live-mode values before recreation and restores **edited or blurred answers**. Fields the user has left alone pick up the new engine's defaults — this is what makes editing a `default_value` expression in edit mode immediately visible in preview.

## Resolved preview identity

`engine/identity.ts` is the ONE identity contract every preview surface speaks — Search/Results session evaluation, form XPath's `commcaresession` user data, the SQL compiler's session bindings, and the acting user behind case writes. Providers are the sole constructors of `ResolvedPreviewIdentity`, and every provider must present a persisted user id: `previewAsMe` and `previewAsPersona` both refuse without one, and no session-only pseudo-persona is constructible.

**Two ids, and they are NOT interchangeable.** `actorUserId` is the signed-in member and the ONLY thing that ever authorizes. `ownerId` is the CommCare worker the preview acts as — the `owner_id` stamped on rows it writes and what `session/context/userid` resolves to. Previewing as yourself makes them the same string; previewing as a persona makes `ownerId` that persona's UUID while the member still authorizes. `ownerId` is authored blueprint content, so keying an authorization decision on it would let an app choose whose data a request reads; `resolveAuthorizedPreviewContext` passes `actorUserId` into the locked authorized-app snapshot before resolving any persona and threads `ownerId` through `withProjectContext(projectId, actorUserId, ownerId)` as the worker only, and the consumer tests pin that the two cannot be re-conflated (including Project-scoped lookup reads, which always use the actor). A Server Action accepts a persona SELECTOR (a uuid) and resolves it against the committed document; it never accepts an identity.

**The usercase reading is the ROW, not a second computation.** `commcare-user` is materialized per app and worker, and `#user/<prop>` on the wire resolves against `casedb` — so once a form can write through `usercase_update` a computed projection and the row diverge the moment a worker answers. They diverge without that too: the sync's never-remove diff keeps a key on the row after the catalog drops the property, while the projection forgets it. The derivation survives as the materializer's INPUT (`lib/domain/usercase.ts`), and `resolveAuthorizedPreviewContext` reads back what the row holds. Never compute the usercase independently here: only the row stays equal to what the device holds. Its case id is distinct from the worker's identity: materialization, submission writes and durable device patches resolve the app-scoped `hq_user_id` join, preserving historical row ids. Previewing as the same signed-in member in different apps therefore keeps independent stored answers.

**Two readings, because the wire has two.** `session` is `instance('commcaresession')/session/…` (`SessionInstanceBuilder.addMetadata` + `addUserProperties`); `usercase` is the `commcare-user` case `#user/<prop>` reads (`sync_usercase.py::_get_user_case_fields`). Same authored data, different built-in keys — `first_name` in the usercase, `commcare_first_name` in the session block — so collapsing them would make one of the two lie. The serializable session projection also carries `userPropertySlugs` (custom UUID→CURRENT slug), which is binding metadata rather than worker data; `previewUserPropertySlugMap` turns it into the typed emitter/compiler map. Thus `session-user-property`, in record slots and form logic alike, evaluates against the same property after a rename without rewriting the stored tree, while name-backed built-in/external arms remain literal. Every session/usercase read uses an own-key lookup, so authored `__proto__` and `constructor` values cannot inherit from the object prototype. **The three location keys diverge, and it is easy to get backwards**: `get_user_session_data` writes all three or none, so the session block omits them while nobody is assigned anywhere, but `_get_user_case_fields` takes an `else` branch to `''` for all three, so the usercase always carries them. Values are otherwise honest: `commcare_project` is ABSENT in BOTH projections until a deployment names one (the domain is never empty on a device, so an empty value would be one no worker can hold), and the worker's name rides as `case_name` rather than `name` (HQ pops `name` into the case's name and never writes it as a property), while the session's first/last/phone keys and the usercase's first/last/phone/email keys are PRESENT, derived when possible and empty otherwise, because HQ writes those slots unconditionally. `user_type` IS present and reads `"standard"` — HQ sends the key only for a practice user, but every `commcare-core .../User.java` constructor calls `setUserType(STANDARD)` before `UserXmlParser::parse` applies any `<data key>`, so the device always has it and a condition on it must behave the same here. A DECLARED property with no value is present-and-empty, matching HQ's `UserData.to_dict` seed, while an undeclared key is genuinely absent — the split a `= ''` comparison depends on.

**The running app reads what the worker's device would hold, and it is a
SEPARATE axis from identity.** CommCare does not filter a restore by
ownership; it takes a fixpoint that ownership only seeds, so previewing as a
worker legitimately shows fewer cases than the builder's case data does
(`lib/case-store/CLAUDE.md` § Restore scope is the rule). The owner set is the
persona's own uuid plus every place it receives cases from
(`lib/organization/ownerSets.ts`); previewing as the member is a worker
assigned nowhere, so it is their own id alone.

A search is not a restore. A Results read of a module with an effective Search,
once its search has run (a search-first module's completed search, or a
submitted Search action), and the Details and selections of cases chosen from
it, pass a search population instead of a restore scope
(`QueryArgs.searchPopulation`, `lib/case-store/CLAUDE.md`): the Project's open
cases of the module's case type, with the owner exclusion and filters, as HQ's
case search reads them, each row marked `heldOnDevice` by the worker's restore.
Choosing a row the device does not hold claims it (`searchClaims.ts`): its id
joins the worker's `previewClaims` (`lib/session`). Preview posts the claim
where CommCare does: when a search action's result is chosen, and in a
search-first module, whose claim sits in each form's entry, once a form is
chosen (Preview's single-form auto-advance included) with the entry's other
case datums under a selected parent, so the form menu and its display
conditions are evaluated before it. Every device-scoped read of that worker
(the device snapshot, a form's preload, the persistent tile, an entry-point
launch) sends the set as plain JSON `claimedCaseIds`;
`resolveAuthorizedPreviewContext` checks its shape
(`previewAuthorization.ts::previewClaimedCaseIds`, at most 1,000 distinct ids)
and puts it in the restore scope, and the restore scope key names it, so the
snapshot is read again when the set grows and the form opens with the case as
on a device. An App Test journey holds its claims in its own server-side
state, `AppTestSessionState.claimedCaseIds`, one set per retained worker
session (`app-tests/CLAUDE.md`); it never reads `previewClaims`.
`engine/evaluateForm.ts`'s capture runs no search and belongs to no running
worker, so it sends no claims and reads the restore closure alone. Preview
writes no claim row. An entry point is not a search: it opens only cases the
worker's restore holds, claimed cases included.

It rides on `AuthorizedPreviewContext`, NOT on `ResolvedPreviewIdentity`. The
identity is the one contract the browser and the server both speak, and the
browser cannot derive this — expanding a persona's assignments reads the place
tree out of Postgres. A server-only field on the shared identity would make
the client's copy quietly wrong, and `samePreviewIdentity` would then compare
a field only one side can fill.

Running screens opt in; builder chrome does not. A browse list's Results, the
canonical Details URL read, a case-loading form's preload, and the persistent
tile pass it; a search's Results does not. The case workspace, sample data, and the rename preflight do not.
`loadCaseDataAction` serves both, which is why it takes an explicit
`deviceScoped` argument rather than deriving one from the context — the
review dialog shares that action, and a derived scope would have silently
stopped it from opening the very rows it exists to inspect.

Fewer rows than the builder shows is not data loss, so `RestoreScopeNote` says
so beside a browse list's Results (a search's Results shows none, because HQ's
search is not a restore): how many cases the same query matches that this worker
would not have, named to the worker. Same doctrine as `HiddenItemsReveal` —
authoring-only inspection sitting BESIDE a runtime-faithful list, never a
blend of the two modes. It cannot list the rows, because the preview never
loaded them, which is the point. That count also OUTRANKS every other empty
state on the screen: the other causes are each read off a tenant-wide count,
so an empty restore over a populated project would otherwise report "no case
data" or blame the worker's Search values, next to a note saying the project
holds hundreds. `restoreScopeEmptyCopy` is the copy that arm renders, and
`PreviewWorkerLabel` is a discriminant rather than a name because previewing
as yourself reads in the second person and as a persona in the third.

`useRestoreScopeKey` is what makes a cached read follow its worker. The scope
is resolved server-side from the persona's assignment, the level catalog, and
the place tree — and the place tree is not in the document, so no doc
subscription can see it move. The hook signs all three (the builder stream's
organization poke covers the Postgres half) and every running surface folds it
into its request identity. Without it the preview keeps serving the previous
worker's rows with nothing on screen to say so, which is the exact failure the
note exists to prevent, arriving through the back door.

Server side, every persona-aware running path — Results/Details reads, sample populate/reset, and submission — calls `resolveAuthorizedPreviewContext` once. It authenticates the member, resolves membership plus the committed blueprint under the same app-row and membership locks, resolves the selector from that one authorized snapshot, and binds the explicit actor/owner pair. A selector naming a missing persona returns `persona-unavailable`; it never silently runs a read or write as the member. The selected owner rides populate/reset and `submitFormAction`, so all rows the persona creates belong to the persona, while the actor remains the authorization and lookup identity. Client side, `useSelectedPreviewIdentityState()` makes selected-but-missing a distinct `persona-unavailable` state rather than collapsing it with signed-out/loading or falling back to the member for one frame. `PreviewShell` replaces the running screens with an explicit unavailable-persona refusal and a **Preview as me** recovery action, while `BuilderFormEngineProvider` marks the `EngineController` blocked so activation cannot execute behind that refusal. Leaving Preview clears the persona selector before edit-only sample/data surfaces become active; the next preview therefore starts as the member unless the author chooses another persona. Visual consumers of the compatibility `useSelectedPreviewIdentity()` keep the server/client hydration render identity-free, while `BuilderFormEngineProvider` opts into a warm cached session and seeds that result on the `EngineController` inside its `useState` initializer — the provider itself renders no identity-dependent markup, and child effects flush before parent effects, so an effect-only install would hand every warm-session form mount an identity-less engine plus an immediate rebuild. A follow-up effect tracks later session changes. Identity is engine-lifetime state: a materially different identity rebuilds any active engine (one evaluation world), a re-derived-but-identical identity is a no-op (`samePreviewIdentity`), a cold session resolving mid-entry restores edited or blurred answers through the engine's shared snapshot/restore (the same contract as blueprint-edit recreation; untouched defaults may depend on the worker and must re-derive), and replacing a NON-null identity (sign-out, different worker) discards — restoring would leak one worker's entries into another's session. React adapter tests that mount `BuilderFormEngineProvider` control `@/lib/auth/hooks/useAuth` so the session atom cannot start an unowned session fetch. Native browser tests may instead exercise the real auth hook against a controlled `/api/auth/get-session` transport, and must join that request and close their browser context. `#user/<prop>` prints the wire's walk to the worker's `commcare-user` row in the device snapshot, NOT the session block, whose built-in keys differ (`first_name` there, `commcare_first_name` in the session). An absent key reads blank at evaluation, matching the device's missing property. The signed-out projection (`previewSessionValues(null)`) carries device context only.

## Several-case selection and batch forms

`caseListConfig.selection.kind === "multiple"` changes the running selection
from a scalar row action to an ordered set. `orderedCaseSelection.ts` is the
pure collection model: insertion-order-preserving dedupe, remove, re-add at the
tail, visible-page select-all capped by remaining capacity, and stale-id removal
all live there rather than in React event handlers. Search submissions, page
changes, Details, review, Back, and compatible module navigation reuse that
same set. The quick filter changes only what is visible; it never edits the
selection. Lowering the authored maximum retains the set and disables Continue
until its size fits.

Results never nests controls. The checkbox selects; the row/tile Details action
opens one record without selecting it. The review tray is persistent, keyboard
reachable, and reports zero and over-limit states through both visible text and
an announcement. Select-all considers the current visible window in its stable
row order and reports when capacity left rows untouched. A grouped tile is still
one runtime choice whose id is the group's first case; its body rows remain
display-only even in multiple-selection mode.

Continue validates the whole set in one bounded server read: distinct ids,
Project/app tenancy, declared case type, current availability, and maximum.
Rows return in database order but are restored to the worker's selection order
before use. Missing, held, wrong-type, and newly inaccessible ids are removed
with one concrete notice; no request-per-case waterfall exists. Zero surviving
ids returns to Results rather than opening an empty form. A validation attempt
retires when its screen unmounts or its selection scope changes, so delayed
replies cannot publish an obsolete target. A current transport failure retains
the choices, releases the controls, and shows retry guidance.

A batch-consuming follow-up or close form receives the collection as a typed
target, never `caseId[0]` and never N simulated form submissions. Shared form
answers and app-level effects evaluate once. Explicit session-case operations
expand over selected ids in selection order; an authored repeat is the outer
axis and selected cases are the inner axis. Every target is reauthorized and
type-checked server-side, and the ordinary lifecycle effects, expanded
operation program, storage writes, and submission receipt commit in one
transaction. A failed target or effect rolls the complete batch back. Ordinary
primary destinations start without a case preload and apply each nonblank
shared answer to every selected case; blank answers preserve every existing
value. The authored cardinality controls that behavior even when exactly one
case is selected, so the form engine never invents a representative case value.
Its logic reads the selection through
`xpathInstances.ts::selectedCasesXPathInstance(datumId, caseIds)`, Core's
`<results><value>case id</value>…</results>` in the worker's order, under the
datum id the entry's projection gives it; `entrySessionData` holds it as
`selectedCases` and the controller hands it to every rebuild of the entry.

The submission Server Action is also an open-tab deployment boundary. A
pre-deploy FormScreen may still send its one followup/close target as `caseId`:
the action keeps that raw object for the durable request digest, normalizes it
to canonical `caseIds: [caseId]` before deriving authority or effects, and
returns the old scalar `caseId` plus flat `childCaseIds` aliases alongside the
new result. The scalar alias exists only when the canonical result contains
exactly one primary case. A real several-case result never chooses a
representative. This also lets a response-lost old request match and replay a
receipt committed by either side of the deployment.

The committed form is the authority for the ordinary submission arm. A
client discriminator that disagrees with its committed type is rejected
before capture preparation or case effects. For a conditional close, the
final protocol carries only the relevant submitted nodes for the referenced
field; the server reloads the committed field, operator, and comparison answer,
evaluates one shared boolean, and closes either the complete ordered selection
or none of it. A false close condition still runs the form's ordinary updates,
children, and operation program atomically; it changes only the close lifecycle
transition.

That authority includes the complete ordinary case-write structure, not just
the form discriminator. The server derives the primary case type, writable
standard/custom destinations, and exact ordinary child buckets from the
committed `deriveCaseWriteInventory`. A child answer carries an internal
`(caseType, nearest repeat UUID or root, concrete repeat instance)` identity;
the server matches it to that inventory, refuses duplicate root buckets or
duplicate repeat instances, derives the relationship, and strips the identity
before storage. Registration primary/children and follow-up/close
patch/children therefore contribute answer values only. They cannot add a
schema-valid but unauthored property, standard scalar, child type, or child
bucket. The accepted child array retains form order, so durable
`authoredChildIndex` receipts and post-submit child routing do not change.

## Results order and the quick filter

The Results list reads its order from the case list's order plan
(`lib/domain/caseListOrder.ts::caseListOrderPlan`), the statement the HQ JSON
and the local suite read too. `engine/caseListOrder.ts::previewCaseStoreOrder`
builds it with `mediaOn: true` (the plan of every production export) and no
lookup naming, over the live `caseListConfig` and its owning candidate document's
catalog, with option labels and an interval's text in the language Preview
shows. `loadCasesAction` takes the live document, `moduleUuid` and `language`,
checks that the supplied settings belong to that module, and resolves its order
from that same document. Membership and worker identity still come from the
saved app. The app test runtime reads the same order.
`caseDataBindingHelpers.ts::buildCaseStoreSortKeys` turns each rule
into the case store's keys in `order` (a multi select's labels are two: the
labels, then the raw value), then the case id for paging. An unsorted list is
the plan's implicit rule on its first shown column; a read with no list to
order (the selection check by `caseIds`) sorts by the case id alone. The
availability filter's sample (`loadFilterPreviewAction`, which takes
`moduleUuid` too) is the list's first rows in that same order. The case
store compares text lowercased by code point, a number only where its trimmed
text is a plain decimal, and places blanks by the rule's `blanks` whatever its
direction (`lib/case-store/postgres/store.ts`).

The quick filter (`components/preview/shared/listFilter.tsx::rowMatchesFilterText`)
matches what a device's search matches, all from the plan: each shown column's
text, each hidden field's text (the raw property, or a hidden calculated
column's value), and each carrier's raw value, in a tile list too.

Where Preview orders differently from a device: an `option-label` key over a
multi select orders by known labels in catalog order and then the raw value,
where a device also appends tokens outside the catalog; text compares by
code point, where Core compares by UTF-16 code unit (they differ only above the
Basic Multilingual Plane); rows that tie on every rule come in case id order,
where a device keeps the order its storage holds them in; and a number written
in a form the plain decimal pattern does not match (an exponent, a leading `+`,
a bare `.5`) is no number in Preview.

## Case tiles in the running app

A `caseListConfig.tile` turns each Results row into a grid. `caseTileLayout.ts`
resolves the geometry and `caseTileRendering.ts` turns it into declarations;
`components/preview/shared/CaseTile.tsx` is the only renderer, shared by the
Results rows and the tile pinned above forms, so the two cannot draw one case
differently. Both files carry the CommCare citations — read them before changing
a number.

Four things the rest of the preview has to know:

- **A tile's fields are the columns it shows.** `tileResultsColumns` selects
  the order plan's fields (`lib/domain/caseListOrder.ts`, rule 1): in a tile
  list, every Results-visible column, each with the cell `tileCellFor` gives it.
  A column hidden from Results is no field of a tile's short detail; an order
  rule on it rides as a sort row with no stored column, for which the device
  appends a zero-width carrier with no `<style>` and no square, so Preview draws
  nothing for it and it neither widens the grid's extent nor flips the tile-wide
  border/shading switch. Every cell states its size and alignment
  (`tileCellSchema`), so `planTileCell` never inherits the list's size.
- **The grid never reflows.** A tile is the device's own phone-first layout, so
  compact widths change the row's gutters and nothing else; the list holds an
  18rem floor and scrolls horizontally below it rather than crushing 12 columns,
  and from the medium breakpoint up the tile is capped at a 48rem measure instead
  of stretching to an extra-large canvas. The reasoning lives on `ResultsTiles`.
- **A grouped tile draws one card per GROUP, and that card is one choice.**
  `caseListConfig.tile.grouping` puts the tile's top `headerRows` rows on the
  group (drawn once, from the group's first case) and everything below them on
  each member. `caseTileGrouping.ts::splitTileGridByGroupHeader` cuts the
  projection, `components/preview/shared/CaseTileGroup.tsx` stacks the halves,
  and both keep the WHOLE tile's `grid-template-*` because the template draws
  header and every body row as separate divs sharing one `-cell-grid-style`
  block. The split reads a cell's START row only, never its height. **Choosing a
  group opens its FIRST case** — Web Apps clones the group's models and removes
  every non-first one from the rendered collection
  (`views.js::CaseTileGroupedListView.initialize`), so the body rows carry no
  id, no checkbox, and no handler; the running list says so permanently rather
  than inventing a per-row selection the device does not have. Reading side:
  `readCases` branches onto `store.queryGrouped` for a BOUNDED read only (the
  form's unpaged auto-selection read stays flat), `rows` stays the flat page in
  clustered order so every row-reading consumer keeps working, and the extra
  `grouped` slot carries the clustering plus a window whose unit is GROUPS while
  `totalCount` still counts cases. A grouped page is therefore unbounded in rows
  — N groups arrive with however many cases they hold, which is
  `EntityListResponse::getEntitiesForCurrentPage`'s own behaviour, not a bug to
  clamp. Cases carrying no such connection all land in the empty-key group,
  because that is what `string(./index/<id>)` evaluates to for them.
- **The persistent tile is a separate read.** `PersistentCaseTile` loads its own
  row with the display config attached so calculated cells project exactly as in
  Results; the form's case read stays display-free because it feeds the engine.
  It sticks to the preview scroller, which is why `FormScreen`'s frame grows with
  its content (`min-h-full` + a growing frame) rather than being pinned to one
  viewport height — a sticky element can only travel as far as its containing
  block.

## Case data resolution

The nav stack carries only `caseId`. Case data is looked up by id at the point of use, not stored in navigation state.

**Per-case-type refs resolve at every reachable depth, positionally.** The engine's case data is a per-case-type map (`CaseDataByType`, case-type name → property map) built by `caseRowsToFormPreloads` with the WIRE's semantic: each reachable type's namespace binds to the row at that type's blueprint depth — the wire's case read (`lib/commcare/xpath/wire/formReads.ts`) emits a blueprint-fixed `index/parent × depth` casedb walk with no case-type filter, so when the live parent chain doesn't mirror the blueprint's `parent_type` chain, preview and device read the SAME row at the hop count (and a depth past the chain's end reads blank on both). The rows come from `readCaseData`, which walks the bound case's `parent_case_id` chain server-side through the `parent` index edges, exactly `ancestorDepth` hops (the form's `reachableCaseTypes(...).length - 1`, client-supplied, server-clamped at 64 — any deeper `parent_type` chain is pathological authoring); the chain is ENRICHMENT — a dangling parent or a mid-walk failure degrades to the rows already fetched, never fails the load. A `#<case_type>/<prop>` read prints the wire's own casedb walk (`lib/commcare/xform/formCaseRead.ts::formCasePropertyRead`, keyed on the datum that holds the form's case, `session/data/case_id_new_<type>_0` for a registration's own case) and evaluates over the device snapshot, so Preview and device read the same row by construction. The per-type map feeds preloads only. `caseRefAcceptMap` decides at authoring time which namespaces a form may reference. Both case-loading form types preload (`followup` AND `close`) only in the module's one-case mode — from the OWN type's entry only, since ancestor namespaces are read-only reference data, and only while the engine's supplied-under type still matches the module's (a mid-preview module retype withholds preload rather than seed field values from an ancestor's row — `ownCaseData`). Several-case mode supplies no primary case-data map at all; the complete device casedb snapshot remains available for admitted operations and after-submit evaluation. Each per-row map (`caseRowToFormPreload`) carries the JSONB document PLUS the reserved scalar columns under their canonical Nova names (`date_opened`, `last_modified`, `case_id`, …), mirroring what the device's casedb exposes.

Case-list sorting belongs to the Results composition. Equal authored sort priorities tie-break by Results position (`listColumnOrder`), never by Details; this is shared with the short-detail wire emitter. The confirmation screen independently renders `detailColumnOrder`, so rearranging Details has no effect on row query order. Both are read through `orderedColumns(config, surface)`.

Case-data authoring is builder chrome, never simulated-app UI. `BreadcrumbStrip` owns the single persistent **Case data** manager: `loadCaseCountAction` reports the complete unfiltered population, an empty type may create samples, and replacing a populated type requires an explicit warning that ALL rows (including hand-entered / Preview-entered cases) are deleted. Successful populate/reset hooks and case-bearing form submissions advance `caseDataInvalidation` for each affected materializable `(appId, caseType)`; `useCases`, `useCaseData`, and `useCaseCount` all subscribe to that revision so one write refreshes every real-data representation instead of manually reloading the surface that launched it. Results and Details edit canvases do not query one case for decoration; real values belong to the running Preview.

The Case data manager's app-wide property-rename review uses
`engine/casePropertyRenamePreflight.ts`, not an optimistic client row count.
The action authorizes current Project view access, loads the authoritative
Blueprint and mutation sequence, admits the exact exclusive rename, evaluates
the complete candidate with the current lookup-definition snapshot, and reads
all live and parked storage counts in that same transaction. Its result is
explanatory only: no write token exists. A scope change makes
`hooks/useCasePropertyRenamePreflight.ts` discard the report, and the dialog
compares its returned `mutationSeq` to the reconciler's current base sequence
so any intervening app commit requires Review again. The later save rechecks
every fact under the authoritative write locks.

Case-search scalar prompt defaults run through `engine/searchExpressionEvaluation.ts`: it emits the authored expression to the same XPath shape as the device and evaluates it with the preview XPath evaluator plus the authenticated user's session values. Date range is deliberately excluded: CommCare binds one paired start/end answer, and the final date-range arm has no scalar default slot, so Preview never invents a From-only default. `hooks/useSearchInputRunState.ts` applies supported defaults once per module, refreshes only untouched prompts when a default/session value changes, and resets submitted state on a module switch; the flipbook therefore preserves worker edits without leaking the prior module's query. `caseSearchConfig.excludedOwnerIds` evaluates once at the authenticated Server Action boundary (so `session-context(userid)` is real), before any case row exists; the shared gate rejects property and relationship reads, while literals/session/Search values and pure calculations remain available. The result splits exactly like CCHQ on whitespace and joins `caseListConfig.filter` + submitted prompts as one Postgres predicate — never a client-side post-filter.

Preview derives navigation from the effective Search action, not from the mere presence of the compatibility settings bag. An explicit zero-input Search action with no Results filter renders one functional manual Search action; with an effective Results filter it submits automatically once for that module/config state. An owner-only exclusion still constrains every Results query, but it mounts no Search screen and triggers no automatic transition by itself. For a prompted Search, `searchButtonDisplayCondition` gates the whole combined Search pane from the case-list action's pre-prompt session/global context; it never reacts to the pane's draft, and the pane's single authored-label submit remains available whenever the action is relevant.

A search-first module (`caseSearchConfig.searchFirst`) is a different composition, decided by `lib/preview/caseListPhase.ts::caseListStep`: `search` (only the Search pane, no results query runs — `useCases` gets no case type), `results` (a completed search's rows, with a **Search again** ghost action that clears the run and refocuses the first prompt), or `browse` for every other module. A search-first module with no visible prompt is on `results` from the start, mirroring the wire's `default_search`; the automatic zero-input launch therefore fires for it whether or not a Results filter exists. `resultsConstraintContext` reads an unconstrained empty answer on `results` as the worker's search rather than an invitation to add case data, so the empty state and the unfiltered-count probe say "nothing matched" there. Post-submit routing reads `effectivePostSubmit`, so a case form in a search-first module returns to the module (Search) rather than to a previous screen that was the search itself.

Expression-bearing Results and Details reads carry the caller's actual live
`BlueprintDoc` plus module UUID. The action authorizes the app and worker from
the saved app, then parses that candidate and checks that its module owns the
requested configuration. Expression contexts, SQL type catalogs and immutable
worker-property names come from the same candidate, preserving edits made
before autosave. Localized display projections stay in the UI; requests carry
the canonical module configuration. `usePreviewMenuSource` selects the stable
in-memory document through `pickBlueprintDoc`, preserving nested identities;
store methods, history flags and store-only indexes never restart an unchanged
request. At action dispatch, `toRscSerializableDoc` makes the plain-object copy
React Flight accepts, including records the store holds with a null prototype.
Raw identity reads need no candidate.

Running Results reads at most 50 cases per page. The action clamps every caller to a bounded window, appends a stable case-id sort tie-breaker, and returns the full matching total plus the effective offset (which may move backward after concurrent deletion). The client resets to page one whenever module, case type, authored configuration, submitted Search, assigned-case exclusion, or destructive replacement changes; an ordinary data update may retain the page, and the server's effective offset keeps a shrunken population from producing a false no-data state. Quick Filter is explicitly page-local whenever more matching cases exist. A canonical Details URL loads its case directly by identity when the row is off-page or excluded, but still sends the live display configuration and case-type catalog so that one row receives the same calculated-column projection as Results; the identity read never inherits Results filtering, sorting, or pagination. Empty worker searches carry an authored-only match count, so Preview says Search caused zero matches only when Cases available would otherwise reveal a row. Deterministic input/config failures use `invalid-search`, not a retryable transport error.

## Places and the form's own wording

A form or link that reads places reads `xpathInstances.ts::locationsXPathInstance(rows, organization)`,
HQ's flat `locations` fixture (`locations/fixtures.py::FlatLocationSerializer`):
places ordered by site code (code point; HQ's `order_by('site_code')` runs
under its database's default collation, which `SQLLocation.site_code` does not
pin and Nova cannot read, so codes that differ at a `_` or `-` can sort
differently on a device than here, while codes of letters and digits agree),
each `<location>` with `@type` (its level code),
`@id`, and an `@<code>_id` for every level, filled from the place's own id and
then its parents' as HQ walks them, so an ancestor at the place's own level
wins, the rest empty; the children `name`, `site_code`, `external_id`,
`latitude`, `longitude` (ten decimal places), `location_type` (the level's
name, as HQ writes it), `supply_point_id` and `location_data` with one child
per place property, empty where unset. The rows are the worker's fixture
(`lib/organization/footprint.ts::locationFixtureRows`, one
`LocationFixtureRow` type), returned as plain JSON by
`loadCaseDatabaseSnapshotAction` beside the device's cases, so they follow
its restore-scope key; a read of places loads that snapshot
(`expressionCaseReads.ts`), and the snapshot carries places only when some
form reads them (`expressionCaseReads.ts::appReadsPlaces`: a `locations`
read or an `owner-location-at-level` owner, over the builder's document,
passed as the action's `includePlaces` and part of the snapshot's reload
key), a submission's patch keeps them
(`caseDatabasePatch.ts`), and a worker assigned nowhere, or an app with no
levels, reads an empty list, in which, as on a device, `count()` is 0 and
every read of a place's field is refused (the path rule below).
`engine/workerLocationFixture.ts::workerLocationFixture`
loads them for that action and for the form check (`evaluate_form`), and App
Tests build them from their pinned places, each by the same `appReadsPlaces`
answer, so a form reads the same places wherever it runs. Only form logic and form links read
places: every module and case-list slot, and a form's display condition, is a
record rule, which refuses a `locations` read (`typeChecker.ts::admission`),
so menus and case lists need no place instance.

`jr:itext` and `jr:choice-name` read the form's own wording.
`engine/formText.ts::previewFormText(doc, formUuid, language)` builds the
itext table from `lib/commcare/xform/itextIds.ts` and the filled prose,
leaving out the entries the XForm leaves out, and maps each select's path to
its written choices, or to `null` where they come from a table or cases; a
language the app doesn't hold reads the default. `xpath/functions.ts::invokeFormTextFunction`
follows Core's `FormDef.initEvalContext`: `jr:itext` of an id with no entry
returns `[itext:<id>]`; `jr:choice-name` compares by exact equality and
returns `''` when nothing matches or the path is no select, and fails for a
select whose choices come from a table or cases, as Core does; outside a form
neither function exists. The form engine builds the table once per document
and sends it to the worker only for a form that reads its wording (`formReadsFormText`);
`formText` crosses as one more field of `XPathWorkerInstances` under worker
protocol 8, since the page and the worker ship in one build.

`secondaryXPathInstances` serves every one of these beside `casedb`,
`commcaresession` and the lookup tables: the selected cases, the search
results, the places and the table aliases, for the form engine and link
evaluation alike.

**Each instance is built as Core checks its paths.** Core checks an absolute
path before reading it (`DataInstance.hasTemplatePath`): every step must reach
a template child or some concrete child, predicates ignored. A path that
reaches nothing is an invalid nodeset: `count()` reads 0, and a value read or
`join` is refused (`runtimeValues.ts::XPathInvalidPathError`, whose `missedIn`
names the secondary instance the path missed, `null` for the form's own). The
places, the lookup tables and the selected cases are plain `TreeElement`s on a
device, so their instances declare their data and no templates: an empty list
refuses every read below it, and a choice list over a table with no rows
refuses its question (`lookupEvaluation.ts::lookupChoicesFromNodeset`, as
`ItemSetUtils` does). `casedb` and `results:inline` are checked against
Core's static casedb spec, whatever the data holds, so they carry that spec
(`xpathInstances.ts::caseTemplate`). The search answers hold only non-blank
answers and no template, so with no prompt answered they refuse as Core does.
Nova prints every value read of these data-built instances guarded by its
rows' count (`lib/commcare/xpath/wire/CLAUDE.md`, "Reads of rows that may be
empty"), so the Search screen's required marks, a no-matches form's search
reads and a form's place and table reads read blank over empty data here as
on a device; what still refuses is a read Nova leaves bare (an itemset, and
the few node-set arguments listed there).
`engine/__tests__/emptyInstanceParity.test.ts` holds each instance to the
answers of a probe of Core at the pin; the plan
(`docs/plans/hq-round-trip/3-expressions/05-instances-session.md`, §2.4's
correction of 2026-10-19) records the probe and the guard.

**Empty data is a refusal, never a fault** (`engine/dataRefusal.ts`). A miss
in a secondary instance (no places for the worker, a table with no rows) and
a choice list over a table with no rows (`lookupChoicesFromNodeset` throws
`PreviewDataRefusal`, which `FormEngine.computeLookupChoices` stamps with the
question) are the Project's data turned away, so `previewDataRefusalOf` tells
them apart from a fault by the error's type, never its message; a miss in the
form's own instance stays a fault. The worker carries the instance id as
`XPathRuntimeFailure.refusal`, beside the diagnostic `error` (which names no
authored data), and `workerFailureError` raises it on the host as the same
`XPathInvalidPathError`. Each surface says what a phone does and what to
change (`runtimeMessages.ts::dataRefusalCopy`, from
`previewDataRefusalSubject`: places, a table by name, a question's or Search
field's choices, a blank search answer), and nothing reaches `faultReporter`
or the client error funnel:

- A form: `EngineController.recordRuntimeFault` records an entry refusal of
  kind `data` (`EngineFormRefusal`, beside the setvalue refusal), with stage
  `form`, or `links` when `evaluateFormLinkXPaths` read it after the save; the
  after-submit route then settles quietly and `FormScreen` shows the panel. A
  refusal at open clears on the next document revision or case-data change
  (the places ride the device snapshot), each opening the form again with the
  entry as now requested, and on a new lookup snapshot only when a table held
  what it found empty (`previewDataRefusalReadsTable`). A refusal at the links
  comes after the submission wrote its cases, so it ends the entry: the
  requested activation goes, nothing opens that form again until `deactivate`
  starts a new entry, and the panel's **Back** is the next step. Opening it
  again would submit the same answers twice.
- A menu's display condition and a Search prompt's choices are read while
  their screen renders, so `PreviewShell` wraps the home, module and case-list
  screens in `PreviewDataRefusalScope` (`components/preview/shared/PreviewDataRefusal.tsx`),
  an error boundary that renders the refusal for `previewDataRefusalOf` errors
  and rethrows every other error to the canvas boundary. A refused choice list
  there is the Search screen's; any other read is the menu's. It tries again
  when the lookup status or the screen changes, and on the next document
  revision, which it watches only while a refusal shows: it notes the
  document's state when it catches the refusal, and a commit that landed
  before the watch began, or a different document, tries the screen again at
  once (`PreviewDataRefusal.tsx::refusalWatchStep`).
- `evaluateFormSnapshot` (App Tests, `evaluate_form`) reports the same refusal
  as a `FormEvaluationInputError` carrying the sentence in the evaluation's
  language.

A case owner moved to the worker's place at a level prints bare, so a phone
refuses that form for a worker assigned nowhere as soon as it calculates the
owner: when the form opens for one of the form's own operations, and as soon
as a row exists for an operation inside a repeat. Preview's owner runs in SQL
at submission, so `FormEngine` refuses at those same points
(`dataRefusal.ts::ownerMovesToNoPlace`, reason `owner-without-place`) when the
snapshot carries an empty place list: at open, and after any change that
leaves a row of such a repeat (`refuseOwnerRowWithoutPlace`). The copy says
the case has no owner to move to. The SQL owner resolves the destination only
among the places of the worker's own fixture (the program's
`workerPlaceIds`), as a device does, reading each place's lineage from the
whole tree. Those are the places the entry opened with: Preview's form
screen sends the ids its device snapshot held with the submission, and an App
Test passes its own snapshot's, so the owner resolves among exactly the
places the form read. Only an entry that carried no snapshot of places has
them read again at submission (`workerLocationFixture.ts::workerPlaceIds`,
the footprint's ids alone).

A choice list Preview computes at form open, so Preview refuses the form at
open where a phone refuses when the question is reached. The export boundary
refuses the same choice list (`LOOKUP_SELECT_SOURCE_EMPTY`, `lib/export`).

## End-of-form links

`previous` is the preceding task from the source entry, never browser Back or
visited-screen history. The wire owner's `previousEntryFrameChildren` also
feeds `previousTaskProjection.ts`, which exposes stable destination and
selection identities without wire names. `engine/previousTask.ts` resolves
only those retained ordered selections against the submitting entry plus its
receipt. Forms-first reopens the exact form's missing record selector;
case-first returns to the module menu with its selected records and updated
values. Computed slots remain runtime values, never invented selections of a
newly created record. Browser and App Tests use this same resolver for both a
static destination and a conditional link's false fallback. Normal Back keeps
its visited-destination behavior.

A retained command continues its task even if the save changes its menu
visibility; a retained form command also continues that exact form through its
selector without choosing again or rechecking its offering condition. A module
command still evaluates its form offerings against the saved values. This is
ephemeral continuation state, never authored configuration or an authorization
bypass. Its captured case database travels into the next form so a just-closed
retained record does not disappear through a fresh restore. It expires when the
worker leaves the task and with the ordinary worker/mode/Project/Home resets. Choosing another form on a retained menu uses the owner's actual entry datums for its missing selectors; it carries the same device world into case forms, registration and surveys. Ordinary Back to that retained menu preserves its world without changing visited-screen history. A successful non-Previous submission retires the completed task and its case target before routing, so returning to the same menu cannot reinstall an older receipt as though the person pressed Back. An explicit module destination also removes its own leaf selection when the owner's target frame omits that slot; separately owned parent selections and explicit form-link selections remain intact.

A form's `formLinks` run in the running app the way they run on a device, through the ONE projection the wire reads (`lib/commcare/formLinkProjection.ts`): which link fires and which case the next form opens with are never re-derived preview-side. `engine/formLinkEvaluation.ts` is the rule, `lib/preview/afterSubmitRouting.ts` is the routing table, and `FormScreen`'s `dispatchAfterSubmit` performs the effect once the submission has landed; a form with no links takes its `postSubmit` destination.

- **First true wins, evaluated as the device's XPath after the write.** Each condition lowers through `projectFormLinkSessionExpression` with its actual document, source form, and link slot, prints at the `preview` target, and the preview evaluator decides it in the entry's post-form scope: `instance('commcaresession')/session/context|user/...` from the identity, `/session/data/<id>` from the entry's session map, which the form's close leaves unchanged, as a device's session is, and `#user/<prop>` and `#<type>/<prop>` through the wire's casedb walk over the device casedb captured at entry and patched by the submission, with the lookup fixtures beside them. The shared checker refuses reads of the closed form. Any case-bearing app with an after-submit link or Previous loads the complete entry-time device casedb even when no expression reads the case database: a link can carry an unchanged existing case or ancestor, while the transaction patch contains only affected rows. `applySubmission` reads every affected row and direct index edge before its transaction commits and persists that exact patch in the durable receipt. Preview applies the patch to the device casedb captured when the entry opened, then derives source and target case preloads from that one world. There is no post-commit case read: it could observe a later writer, and a fresh restore can omit a just-closed case the device still retains locally until sync. Registration-created cases, advanced-operation targets, and the worker usercase all enter through the same patch. A survey with no case or usercase effects contributes an empty patch. A direct linked form carries both its case preload and this patched casedb across navigation so its first render cannot replace a just-closed case with a newer restore. The write is announced to the other running surfaces (`invalidateCaseData`) only once the route is decided: announcing earlier could reload or clear the source binding before routing finishes.
- **The carried case is the wire's match, valued from the complete case session.** `carriedCaseFor` asks `selectedCaseDatumId` for the target's projected own-case selection datum (`case_id` when flat, potentially `case_id_<type>` after root-menu alignment), evaluates a manual datum under that exact id when the link names its datums, and otherwise reads the source datum `matchFrameToSource` picked. The entry's session map (`entrySessionData`, held by `EngineController.entrySession`; `afterSubmitSessionDatums` adds the names the submission saved) is the one mapping from source datum ids to values: the projected own-case datum is the case the form loaded; every projected ancestor/inherited selection reads the module-keyed case session that `FormScreen` already resolved through `previewMenuCaseContext`; a registration's `case_id_new_<module type>_0` is the id the submission created its case with: the id the entry minted, or the id a receipt replayed from before entries minted ids saved; and a non-repeat child's `case_id_new_<type>_<n>` is the id its child was created with. `projectTargetCaseSelections` values EVERY matched selection datum in the target frame; the exact `FrameDatum` already carries its stable source-module UUID through root alignment and frame-prefix projection, so Preview never reconstructs ownership from menu shape or display names. `FormScreen` applies that root-to-leaf projection before navigating, so manual parent datums and automatically matched created cases establish the same nested menu session the device frame establishes. Parent changes clear stale descendants before later target selections replace them; a defined blank datum stays installed so Core and Preview both skip a picker, while its empty id still binds no case. A nonblank selection is hydrated from the exact matching row in the transaction-captured post-submit patch before a module menu evaluates case-property conditions. Module landing is decided from that prospective session, including same-type structural inheritance, not from the pre-submit menu snapshot. The created-child mapping comes from the durable structured receipt: every concrete child names its authored child index and selected/generated parent, so `FormScreen` never infers metadata from flat result order. A historical receipt that carries only flat child ids remains replayable, but contributes no created-child metadata because that mapping cannot be proved. A child created in a repeat takes a fresh id per iteration and has no session datum, as on a device, so a repeat bucket of the same type never shadows a non-repeat child's datum. A manual XPath reads the same map, so `instance('commcaresession')/session/data/case_id_new_patient_1` names the created child.
- **A blank carried value binds nothing, visibly.** `previewCaseTarget.caseId === ""` is a case the navigation bound, to nothing; `FormScreen` opens the form without auto-selecting a case, loads nothing, disables Submit, and says the link carried no case. Absent `caseId` keeps meaning "direct preview, auto-select the first case".
- **Running menus use one UUID/topology projection.** `menuProjection.ts` consumes `lib/domain/moduleHierarchy.ts`: Home renders root modules only, while a parent module renders its native Forms (or an explicit **Cases** entry) plus its child-module tiles. `PreviewScreen` carries module/Form UUIDs, and retained component + scroll keys come from those UUIDs, so reorder cannot transfer state to a sibling. Module conditions combine through ancestry with `hidden` winning over `pending`; a child condition previews on its structural parent menu rather than Home.
- **A module target lands where the home screen lands it.** `moduleLanding.ts` reads the module-URL rule (`moduleScreenNavigation.ts`) from the outside: a module with children always lands on its menu so those children remain reachable; a terminal case-first or bare-case-list module opens Results unless its menu already has a selected case. Home tiles and after-submit module targets use the same rule.
- **Menu selection and Form launch are separate session facts.** A case-list/case-first parent selected through its explicit **Cases** entry stores a UUID-keyed ordered case set and returns to the parent menu; it does not seed a Form target. Same-case-type structural children may reuse that complete set only when `caseSelectionCanFlowBetweenModules` proves their authored type, cardinality, and maxima compatible. Different-type modules follow their explicit `parentCaseModuleUuid`, independently of structural menu parentage. An absent selector leaves the list flat even when its record type has a parent; Preview records an ordered selector/return chain, selects there, then constrains the child's Results query to the union of direct non-extension children of EVERY selected parent before continuing. A direct running Form or Results URL enters through that same module checkpoint while the parent selection is missing, so deep links cannot skip the chain. For a basic registration form, the selected parents remain navigation/session context: the form does not preload them or persist a primary-case index. Never infer case ancestry from `parentModuleUuid`.
- **The submit row stays running until the next screen is pushed**, because the write has landed and a second press must not land it again. A failure after the write (the read-back did not answer a row, the target is not in the document, the evaluation threw) settles an inline error that says the answers were saved and logs through `log.error`; it never throws and never silently goes back.

## The completed-search context and the no-matches form

A search-first module's running state is ONE fact per module in the session
store, `previewSearchStates[moduleUuid]` (`lib/session/previewSearchState.ts`):
`not-searched | running | failed | completed { matchCount, registeredCaseId? }`,
each attempt numbered, each carrying the answers the worker searched with
(visible values plus the hidden values `useSearchInputRunState.resolveHidden`
evaluated at submit). `CaseListScreen` is the only writer: `submitSearch`
begins the attempt (the automatic zero-input launch included), and the settle
effect completes or fails it from `engine/searchPhase.ts::searchOutcomeFromLoad`
over the `useCases` load, but only after it has SEEN a fetch start and end for
that attempt (`awaitingSearchFetchRef` / `sawSearchFetchRef`), because the
submit commits before the query effect fires and an earlier load's `rows`
would otherwise settle the new attempt. **Search again** resets to
not-searched. Failure is its own state: an `invalid-search`, transport, or
persona refusal is not "no matches", and nothing is offered on it. The
screen's run state (`useSearchInputRunState`) is screen-local while the
context outlives the screen, so `CaseListScreen` keeps them one search: on a
module's first pass the run state follows the context (`restore`, so a form
of the module that returned to its list finds the standing search, as the
device re-runs the query it kept); after that a retired context clears the
run state, and a run state the screen dropped on its own retires the context.
The context keeps the screen's answers (a date range as its two bounds);
`runtimeBindings.ts::searchInputInstanceValues` folds them to the instance's
one field per prompt where `FormScreen` hands them to the engine.

A menu form of a search-first module that reads what the search found
(`xpathInstances.ts::formReadsSearchResults`, a walk of the form's and its
questions' expression slots, links included) reads `results:inline`.
`engine/searchResultsSnapshot.ts::readSearchResultsSnapshot`, through
`caseDataBinding.ts::loadSearchResultsSnapshotAction`, runs the completed
attempt's Results read (`prepareRunningCaseRead`, which `loadCasesAction`
shares) without a page window, up to `SEARCH_RESULTS_CAP` (500) rows while
counting every match, reads each row's direct indices, and returns
`{ rows, totalMatches }` as plain JSON. `xpathInstances.ts::searchResultsXPathInstance(rows, catalog)`
writes HQ's `CaseDBXMLGenerator` shape: every row `status="open"`,
`last_modified` in `json_format_datetime`, `date_opened` as the UTC day,
`external_id` only when set, a date-and-time property in HQ's spelling, and
`index` only when the case has indices, sorted by identifier, with
`@relationship` only for an extension; no related rows and no score.
`hooks/useSearchResultsSnapshot.ts` loads it for `FormScreen`, keyed by the
attempt, its answers, the case a no-matches registration added, the worker and
the parent selection. It is never keyed by claims, because a search reads the
Project's open cases rather than the restore and the claim posts as the form
opens, nor by the document's identity: the entry keeps the snapshot it opened
with through every rebuild and **Clear form**, as a device's session keeps its
query step, and a new attempt reads again. The engine waits for it
(`FormEngineRuntimeOptions.searchResults`, carried by `entrySessionData`), and
the after-submit links read the same snapshot. With no completed attempt the
form shows the no-matches form's refusal panel with **Go to Search** and the
engine never activates; while the snapshot loads one line says so, and a
failed read offers to try again. A search its own inputs or settings refuse
(`invalid-search`, `useSearchResultsSnapshot.ts::searchResultsLoadState`)
fails the same way on every try, so the form shows that refusal's message in
the same panel with **Go to Search**, never a retry. When the search found more than 500 cases,
one line says the form reads 500 of them, as a device does. `evaluateFormSnapshot`
refuses a form that reads search results when its caller supplies no
snapshot, with the panel's sentence. The server-side runs of a session, an
App Test's steps and the form check (`evaluate_form`), compose the same read
through `engine/serverSearchRead.ts::serverRecordsRead` (the search screen in
the bounded worker, then the Results read without a page window) and
`serverSearchResults`, which hands it to `readSearchResultsSnapshot`. An App
Test reads it once, at the entry's first evaluation, and holds it on the form
screen for every later step and the submission (`app-tests/run.ts::appTestFormContext`);
a new entry reads again. The form check runs the search screen first and
refuses with its own sentence when the module's Search action is hidden for
the worker (its display condition is false), since no `searchAnswers` can
open that form (`evaluationContext.ts::formSearchResults`).

The no-matches registration form (`Form.entry`, the wire's `case_list_form`)
is admitted or refused by `lib/preview/noMatchesForm.ts::noMatchesFormAdmission`,
and both screens ask it. Results renders the **Register** action inside the
empty notice only while `noMatchesActionAvailable` (completed with zero
matches); pressing it sets `previewCaseTarget.searchLaunch = { moduleUuid,
attempt }` and opens the form. `FormScreen` admits the form only for a launch
naming its own module and the CURRENT completed empty attempt; a direct URL,
another module's launch, a search still running or failed, matches found, or a
launch a later search superseded shows the refusal panel ("This form opens
after a search finds no matches" plus the next step and **Go to Search**),
and the engine never activates. An admitted launch hands the attempt's answers
to `useFormEngine → engineController → FormEngine.runtimeOptions.searchAnswers`:
`xpathInstances.ts::searchInputXPathInstance` synthesizes the
`search-input:results:inline` instance beside `commcaresession`, and
`#search/<name>` prints as the wire's
`instance('search-input:results:inline')/input/field[@name='<name>']`, so
`count()` sees a prompt the search left blank as no node, on the synchronous
and the worker path alike.

After submit, `FormScreen.dispatchAfterSubmit` lands a no-matches registration
BEFORE any link (the form has none), as the wire's return frame does. A host
with menu forms records the new case on the module's state
(`recordRegisteredCase`: the same attempt, now completed with one match and
`registeredCaseId`, which also closes the no-matches door) and opens the case
list, where Results reads only that case (`useCases({ caseIds })`, the
answers no longer narrowing it), mirroring the `case_fixture` frame. A host
without menu forms has a frame of the host command alone, so its context
retires and the module opens on Search again (or its automatic Results). The
form is on no menu:
`ModuleScreen`, `HomeScreen`'s form counts, and the case-list form menu read
`useOrderedMenuForms` / `useMenuFormCounts`, while `screenProjection.ts` still
projects the form URL so a stale link meets the refusal rather than a blank
screen.

## Case-data Server Action wire shape (edge-WAF constraint)

Two rules govern the args these `caseDataBinding` Server Actions take. The edge Cloud Armor CRS rules that punish breaking them run in **log-only / preview** mode today (`scripts/infra/setup-cloud-armor-lb.sh` — they record would-be blocks, they don't 403), so this is wire hygiene that keeps the previewed-match logs clean enough to eventually enforce, not a hard gate:

- **Args must be plain JSON — never a `Map`/`Set`/`File`/`Blob`/`Date`.** React also refuses records with a null prototype; document arguments use `toRscSerializableDoc` at dispatch to make plain-object copies. React encodes a Server Action call as `multipart/form-data` the moment any argument holds one of those built-in objects (a `Map` serializes as `$Q`, which forces a `FormData`); a plain-JSON payload goes as a `text/plain` body. The multipart envelope's `\r\nContent-Disposition: form-data; name=` part-header is what CRS `921150` reads as header injection. The running-app search bag is a `Map` in the client (`SearchInputValues`) and crosses as a plain object (`searchInputValuesToWire` / `…FromWire`) for exactly this reason. The worker's claims cross as a plain string array (`claimedCaseIds`), and the viewer's position as a plain `{ latitude, longitude }` or `null`. A Search's runtime query values, evaluated in the browser, cross as plain objects (`{ segments, choices }`) for the server to fold: `engine/searchCsqlRuntime.ts::evaluateSearchCsqlRuntime` composes the module's filter and advanced-input rows as the export does (each in its own slot's context, each chosen case under the case list step's datum id), evaluates each runtime segment's value, each runtime choice's condition and each row's obligations over the Search screen's world (answers, the step's `session/data`, the device's cases and places, lookup tables), and keys them `<row>:<segment key>`, a row whose obligations hold as the choice `<row>`; `foldSearchCsql` folds each row with `lib/commcare/csql/fold.ts::foldCsqlRuntime`, a rejected row makes the read `empty`, and a simple input's answer still binds as its literal (`composeRuntimeFilter`). A read Preview's synchronous evaluator cannot run gives no value and leaves its node to the store as authored; the `list-item` obligation, whose condition needs `regex`, is decided over the same values. App Tests' records reads (`serverSearchRead.ts`) evaluate the same values on the server over the session's device. A browse list's filter that reads the case chosen in an earlier menu sends `chosenCaseIds` (module UUID to case id, from the same step map) as plain JSON, bound as `TermBindings.chosenCaseIds`. The server's own pass of a search's checks judges only obligations whose reads it holds (the answers and the session context); one that reads the device's cases, a lookup or a session datum is the browser's to judge, through the row it reports.
- **Expression-bearing reads carry their actual live document.** `loadCasesAction` and the Details projection of `loadCaseDataAction` take the live `BlueprintDoc` and `moduleUuid` beside their list settings. They validate the document's shape and require the supplied settings to match that exact module before deriving slot context, catalog types and order. Membership, actor and worker identity still resolve from the saved app; the candidate never authorizes data access. This keeps a property rename, retype or expression edit in one evaluation world. The payload is plain JSON, including its document and search answers. Raw form loads omit the expression context. `loadCaseCountAction` takes `(appId, caseType)` plus an optional parent selection, while sample populate/reset take the live `CaseType`. A nested parent-select Results or Details request carries one plain-JSON `ParentCaseSelection` with the selected parent type and ordered case-id set. The case store validates the complete set against the app, Project and type, then constrains both reads through the same union of direct non-extension case-index populations.

## `commcare_project` comes from the deployment record

Preview names the project space a worker signed into exactly when one
deployment of this app has reached `uploaded` — the app is genuinely on that
project space, so a worker could have signed into it. It stays ABSENT when none
has, and when several have: choosing between two real answers would make a
condition on `commcare_project` pass here and fail for half the workers.
`lib/deployment/previewTarget.ts` is the rule, the builder page resolves it
server-side, and `DeploymentTargetProvider` carries it — durable server state,
so deliberately not the ephemeral session store.

It IS a usercase property in a way it is not a session key —
`callcenter/sync_usercase.py::_get_user_case_fields` ends with an unconditional
`fields.update({... 'commcare_project': domain})`, while
`users/models.py::CouchUser.get_user_session_data` is the sole injector of the
session copy. But **neither projection emits it empty**, and that is the split
from `language` and `phone_number`: HQ genuinely writes those as `''`
(`user.language or ''`), whereas the domain is never empty on a device. An
empty `commcare_project` is a value no worker can hold, so `= ''` would fire
here and never in the field; absent behaves like the device for every
comparison.

**The name key is `case_name`, not `name`.** `_get_user_case_fields` does put
`name` in its dict, but both writers pop it straight back out into the case's
name (`_UserCaseHelper.create_usercase`: `case_name=fields.pop('name', None)`;
`::update_user_case`: `kwargs['case_name'] = fields.pop('name')`), so it never
reaches the case's `<update>`. The device exposes the casedb's own `case_name`
node (`commcare-core .../CaseChildElement.java`), and HQ's
`app_schemas/case_properties.py::get_usercase_properties` lists no `name`
either.

**Every identity resolver threads the project space, not just the client one.**
`useSelectedPreviewIdentity` (browser), `resolveAuthorizedPreviewContext`
(server actions), and `submitFormAction` all pass it, because the
server-resolved identity is what binds `sessionUser` for the SQL compiler. A
client that had it and a server that did not would make one expression answer
two ways depending on which side evaluated it — the hardest kind of difference
to notice, since both halves look right alone. `lib/deployment/previewSpace.ts`
is the one resolver, kept out of the publish lifecycle module so a case-data
action does not import the expander and the HQ client to ask one question of
one table.

**The client copy follows every path that can change it, own-tab and
cross-tab alike.** The builder page resolves it server-side on load, the
publish response carries the server's fresh answer whether the publish
landed or was refused, and every Check status returns `previewProjectSpace`
beside the refreshed record (`RefreshedDeploymentView`); the publish dialog
applies all three to `DeploymentTargetProvider`. Every OTHER tab — a
co-member's open builder, a second tab of your own — converges through the
shared realtime stream: each deployment write pokes the app channel's
deployment lane in its own transaction, the relay re-resolves the rule and
emits a `preview-project-space` frame, and `DeploymentTargetProvider`
subscribes through the reconciler's `subscribePreviewProjectSpace` seam.
Every value on every path is the SERVER's resolution; a client-asserted one
would bypass the ambiguity rule only the server can apply.

## Entry-point launch

`entryPointLaunchAction.ts` resolves the committed app, actor, Project, and optional
persona through the ordinary authorized Preview context. Its sequence must match
the caller's saved revision before reads and a fresh authorized snapshot after
reads. Case bindings come from one mandatory restore-scoped device snapshot; the
pure `prepareEntryPointLaunch` checks shared endpoint selection requirements,
ordered distinct IDs, case types, direct child indices, and prospective navigation
visibility. It never claims cases, records a completed search, or fabricates Search
answers. A case absent from that worker's restore refuses the launch.

The session installer publishes the complete identity and case bindings together.
The launch hook discards a response after a document, scope, identity, or request
generation change. The shell owns launch lifetime after the setup picker unmounts:
an edited document or changed persona retires the endpoint and returns to setup;
normal navigation expires its display-condition bypass while preserving the
ordinary menu selections needed by the next screen. A bypass applies only to an
explicit form entry point at its exact active destination, never to a normal URL.
A bare module entry point keeps the actual module menu, with Cases as a separate
choice; ordinary bare-module navigation follows the module-landing rule (`moduleLanding.ts`).

An explicitly authored `postSubmit: "firstMenu"` on a no-matches registration
returns to the home screen and retires that search/form/parent request, matching
HQ's empty root frame. It never records the newly registered scalar case as a
completed-search result. With no explicit override it returns to Results showing
the registered case (§ The completed-search context); admission excludes that
implicit return for a multiple-selection host.

Unexpected lookup-preview, filter-preview, sample-data, and submission failures return stable retry copy. Typed domain refusals keep their actionable payloads; unexpected exception details stay in server telemetry.


## Authoring evaluations

`app-tests/` owns disposable multi-form journeys exposed to agents and retained
as Builder Test journeys. Read its `CLAUDE.md` for authorization, pinned inputs,
transaction isolation, checkpoints, expiry and observation boundaries. Ordinary
Preview continues to submit real records. Navigation conditions stay pending
while client identity is unresolved; a missing worker is not a worker with blank
role values.

`engine/evaluateForm.ts` owns one Node worker per non-writing form evaluation.
`engine/evaluateFormSnapshot.ts` uses the same `buildEngineInput`, FormEngine,
lookup projection and XPath dispatcher as Preview. The thread captures authorized
records and lookup rows without materializing schemas, usercases or sample data.
It is bounded to 30 seconds and a 128 MiB V8 heap, and the host always terminates and joins
it. A result is question state and a proposed submission, not a storage receipt.
A form Core would refuse at a setvalue is `FormRefusedError` (`form-refused`),
with the sentence Preview shows. Each evaluation mints its own entry key before
it builds the entry's session map, so its proposed submission names the case ids
its logic read.
The authoring tool can supply an explicit scenario instead of reading stored
records. That population is admitted against the app's derived case schemas,
kept separate from real records, and discarded after evaluation. It does not
change the running app's real-data model or validate a storage transaction.
The build script emits its server asset beside the separately bundled browser
XPath worker; neither server execution nor form-engine code enters the browser
XPath asset.

The observation worker retains typed XPath failures until FormEngine has applied
the same custom-constraint wording policy as interactive Preview. Ambiguous or
empty wording yields the localized invalid warning and a retained invalid entry,
without a submission. Uncaught failures from rules, ordinary prose and other
expressions keep the existing authoring-input fault with its path, expression,
code and bounded reason.

Request authentication and Preview worker resolution live in
`engine/previewAuthorization.ts`. The production I/O and submission helpers in
`engine/caseDataBindingHelpers.ts` accept authorized stores and do not import
request authentication; disposable tests and background callers can use them
without manufacturing a Next.js request. Submission worker overlays match the
`commcare-user` row's `hq_user_id`, not its distinct case UUID. Input-free Search
launch uses `caseListPhase.ts::automaticallyLaunchesSearch` in both the running
app and journey observations.

Form checks and isolated journey answers share `engine/formAnswerValue.ts`: typed location coordinates use the production picker formatter; malformed supplied values fail as test-input errors before evaluation. Raw location strings must satisfy the same grammar as case storage. Authored defaults and worker validation remain engine observations. This does not exercise the map or device GPS.

## Spoken field positions

Interactive Preview numbers rendered siblings within each container.
`engine/formPresentation.ts` walks the authored field tree in order and expands
concrete repeat instances. Its worker hierarchy retains headings, resolved prose,
media, page membership and manual repeat controls. Its complete field projection
also retains hidden calculations and excluded answers, separately from worker
visibility. `evaluateFormSnapshot` uses this projection rather than runtime-store
insertion order, including after restoring an entry checkpoint.

`useVisibleFieldOrder` and `useVisibleRepeatInstances` use the same presentation
rules with the controller's concrete runtime paths. An automatic repeat with no
title, media or visible content adds no shell; its hidden calculations still run.
Automatic iterations with no visible content add no instance dividers. Worker-added
repeats retain their controls even with no visible questions. The hooks' shallow
UUID/index projections do not publish value-only updates. Retained field and
repeat-instance keys keep input identity stable as conditional siblings appear
or disappear. Browser acceptance still owns layout, focus and physical control
behavior; an ordered hierarchy is a structural observation.

The running home screen shows authored module names. Internal case-type badges
belong only to edit mode; they are not worker instructions or record labels.

Successful post-submit navigation forgets section memory for the completed form
and an immediately linked destination form. The fresh entry chooses its first
visible section from fresh answers; failed submissions and edit/Preview flips
keep their page.

Case-list values share `columnDisplay.ts` across the browser renderer, Quick
Filter and disposable Details observations. It owns typed formatting and value
fallbacks without React. `caseColumnLabel.ts` shares the property-label projection
from `lib/domain/propertyDisplay.ts`; neither test observations nor UI invent a
second fallback label.

Section entry uses the shared engine in browser and form workers. Pages whose
pending rows may reveal prompts stay available until insertion resolves them;
an empty result re-anchors through the shared paging projection. Revealing an
uncreated repeat on the current page also inserts it, under the controller’s
atomic topology barrier. Later input cannot interrupt a partially created row.

The `preview` print reads record metadata (`case_id`, `case_type`, `owner_id`,
`status`) through the attribute steps form export writes. The casedb projection includes external ID as both its
attribute and copied child, as Core does. Its opening/modification DateData values
remain calendar dates in expressions, even though Postgres stores timestamps.

A case-loading form opened in Edit also defers its first engine activation until
the selected record and ancestors are ready. The authoring canvas remains
available without a running entry; entering Preview supplies its selected record
before one-time defaults or query membership run. Returning to Edit from an
already initialized Preview retains that entry and its answers.

Results/Details and their Quick Filter share `columnDisplay`'s read projection
under the list's reading: in a browse list (`casedb`) built-in
opening/modification timestamps show the worker's calendar date, and over a
search's results (`results`) `date_opened` shows HQ's UTC day and
`last_modified` its instant, including direct plain, date, mapping and interval
columns. Raw row and form-preload accessors remain unchanged. Calculated
columns compile under the same reading (`lib/case-store/sql/CLAUDE.md`,
"Readings"), so a search's plain and calculated `date_opened` show one day, and
their display type follows value branches without changing authored admission.
A column that reads `here()` runs with the browser's position as one bound text
parameter (`TermBindings.viewerLocation`, the spelling a CommCare location
handler given a browser position returns, `''` until a position arrives). The
browser asks only while a list whose Results show such a column is on screen
(`engine/viewerLocation.ts::columnsReadHere`), once per session; each list
that mounts watches (`hooks/useViewerPosition.ts`), and the list's read keys
on the position state's move counter (`lib/session/viewerPosition.ts`), so it
reads again on the first position and after a move of more than 30 metres from
the position it last showed, and the watch stops once a fix of 1,600 metres
accuracy or better is in hand. That is CommCare Android's rule
(`AndroidHereFunctionHandler.java::REFRESH_METER_DELTA`,
`::shouldRefreshEntityList`, `GeoUtils.java::DEFAULT_ACCEPTABLE_ACCURACY`): Web
Apps' list rows never read the worker's location, so Android's handler is the
one CommCare rule for a moving position. A list read sends the latest fix and
records it as shown; Details and the tile send the latest without recording it.
The note beside the list (`runtimeMessages.ts`, `hereColumns*`) says why the
columns are blank and offers **Share your location** while the browser has
not answered, or **Try again** after it could not find a position. Nova stores and logs neither. A custom datetime retains its clock; metadata
columns cannot recover time by adding a clock pattern.

Case-backed single/multiple-choice questions join the same choices DAG and
retention path as table choices. They require the existing device-scoped captured
case database even without a filter. The shared itemset emitter runs through the
ordinary XPath worker; the engine indexes its existing immutable secondary case
nodes once for labels. It does not fetch Project-wide cases, approximate ownership,
clone the snapshot per candidate or interpret predicates in another evaluator.
Absent snapshot remains loading; an available empty snapshot produces no choices;
evaluation errors use the existing runtime error boundary.
