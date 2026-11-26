# Question display, case lists and case details

A worker can search choices by typing, see the picture for the language they picked, and open a case detail with
a tab for each of its children. The author edits the question, the language or the case view where that choice
belongs. A later save in CommCare HQ reaches the same typed slots through Bring in changes.

At Nova `9a6dc789` the two owners account for 63 and 61 HELD-NEW entries respectively. Neither owns a
circumstance in `CIRCUMSTANCE_STANDINGS`. The row index below assigns every entry a delivery slice. The reader
still accounts for the whole containing question, column or detail. An invalid container gets one finding at the
offending part, with the rest of the container covered under it.

The source pins are HQ `d6c6e16d8ae1`, Core `8e9ba8d908e9`, Android `7a5584475580`, Formplayer `24383ac71bfb`
and HQ's Vellum `01215f251c57`. The
[research inventory](../../../research/2026-09-26-hq-round-trip/inventory/README.md) names the wire vocabulary.
[Nova's field and case vocabulary](../../../../lib/domain/CLAUDE.md),
[reader contract](../../../../lib/commcare/reader/CLAUDE.md),
[worker-language contract](../../../architecture/multilingual-localization.md) and
[compiled app contracts](../../../architecture/complex-apps.md) describe the starting point.

## Group 3. How a question looks

### Q1. Controls and their display settings

Today `fieldDisplay.ts` enumerates string-valued settings for the Number keypad and `fieldAppearance` writes a
kind's token first. Extend the registry to describe flags, enumerations, counts and topic references as well.
Each kind schema declares only settings its generated control reads. The registry supplies the Builder labels,
values, applicable kinds, platform-use detector and wire projection. Give `addFields`, `editField` and their
shared MCP calls the same typed per-kind inputs. A cleared optional setting restores the ordinary widget. Carry
settings across kind conversion only when their values and combinations are valid on the new kind. The following
are decisions for those schemas.

| Carrier | Author's choice and wire projection | What Preview must distinguish |
|---|---|---|
| Single and multiple choice | `choiceLayout` offers dropdown (`minimal`), grid (`compact` or `compact-N`), table row (`list`), row without its label (`list-nolabel`) and headings (`label`). Single choice adds search box (`combobox`), buttons (`button-select`), and `advanceOnChoice` for ordinary or grid selection (`quick`). `gridColumns` is a positive Java int when there is an actual fixed column count. | Draw the worker's dropdown or spinner, grid, row, headings and choice buttons according to the selected platform. Android grid count comes from parsing the entire suffix after the **first** hyphen as a Java integer. A suffix it cannot parse chooses the automatic grid. Preserve a grid's quick selection even where that count falls back. |
| Searchable single choice | `matchWords` has the default search, whole words on Web Apps and substring matching on Android (`combobox multiword`), and fuzzy matching (`combobox fuzzy`). Distinct variants select an Android-only match when Web Apps' second word does not turn it on. | Use the platform algorithms on the same ordered option values. Pressing Enter, choosing and clearing update the same saved answer identity. Show this choice only for the search box. |
| Text, password, barcode | Keep `keypad: numbers` for `numeric` and add `keypad: android-numbers` for `numbers` where that control reads it. `addressLookup` selects Web Apps' address finder on text or barcode. `inputWidth` offers short and medium for the inputs Web Apps narrows. | Web Apps' numeric password entry shows the answer as typed. Android masks it. Android reads short's keyboard action only on a matching whole appearance and applicable input. Keep barcode scanning available on Android where Web Apps uses a text input. |
| Text and choice receivers, address and upload senders | `sendTopics` is the ordered set of channels to which this entry publishes. `receiveFrom` holds one channel and one returned field. Pick existing channels or name a channel on the form. Translate the outer tokens `broadcast-…` and `receive-…-…` in the CommCare boundary. | An address selection and an upload's filename notify the subscribed text, barcode, radio or search-box entry. Clearing the sender clears a receiver as the upstream entry does. Web Apps does not subscribe a dropdown or choice buttons. Android ignores this mechanism. Test the same channel on two separate form sessions. |
| Hint | `hintPlacement: placeholder` on visible questions. A question that otherwise shows its hint but whose widget cannot show a placeholder takes the explicit value `hidden-on-web` when it has that wire reading. | Show the hint as the entry's placeholder only on a widget which consumes it. Test an empty and a populated input, an address, a password, both search and dropdown selects, and a checkbox list. Android still shows its ordinary hint. |
| Barcode, date, time, location | `scanOnOpen` and `canEditScan` select `quick` and `editable`. `calendar` selects Ethiopian, Nepali, Gregorian, or Gregorian with Cancel. `clock: twelve-hour` selects `12-hour`. `locationPicker: map` selects `maps`. | Barcode quick is a whole-value test on Android while editable is a substring test. Exercise accepting and cancelling a scan and date selection. Calendar display changes the picker while the submitted date stays the civil date it selected. The exact appearance `ethiopian` opens the Ethiopian calendar on both platforms. Web Apps runs the 12-hour clock. Android runs the Nepali and Gregorian settings and the map picker. |
| Image, audio, video | `captureSource` offers camera only for image and video (`acquire`) and record or choose for audio (`acquire-or-upload`). `overlaySize: small`, `recorder: legacy` and `longRecording` select their respective widgets. | Use the same staging and submission paths as ordinary captures. Android supplies these differences. The long setting applies at API 24 or later. Web Apps keeps the existing capture control. Compare camera/chooser affordances and accepted staged bytes independently. |
| Label | `selectableText` and `banner` (good, caution, bad, hidden) choose `selectable`, the three exact floating values and `floating-hidden`. Each replaces the label's normal `minimal`. | Android offers selection or the matching banner. Other strings beginning with `floating-` hide the label there. Preserve later Web Apps settings that still take effect. A trigger requiring an acknowledgment belongs to group 8's question kind, including when one extra token changes `minimal` into an interactive trigger on Android. |
| Group, repeat layout and alignment | `compact`, `collapse` (closed, open), `border`. Use `itemsPerRow` on a visible question or eligible container, `repeatsPerRow` on the outer group with a direct repeat, and `textAlignment` (center, right) on the controls named by the classifier. `group.fieldList` and a section keep their present one-screen semantics where Core recognizes them. | Web Apps groups, borders, aligns and lays out the row. Android runs a compact group on its whole appearance. Web Apps reads the first applicable count, parses its leading decimal digits and rounds 12 divided by the count. Do not clamp valid counts to 12. Confirm zero, enormous counts and invalid widths on the real browser as separate classes, representing their effective layout by a finite value when a count cannot be stored exactly. |

Count and channel grammars are part of the wire adapter. For Android a fixed positive grid count is 1 through
2,147,483,647. For row layout store the exact decimal as a normalized digit string when it is wider than
JavaScript's safe-integer range and derive the Web Apps width with its Number semantics. A zero row divisor and
a width rounding to zero each need their own renderer witness. Empty or otherwise unconstrained channel text is
interpreted as the reader interprets it. Web Apps splits on literal spaces, matches `broadcast-(.*)`, and splits
a receiver at its **last** hyphen. The persisted atoms are opaque channel and returned-field names, each
incapable of containing a plain space, with a canonical wire candidate tested against all applicable appearance
reads. Keep the appearance finding for a name which changes a different setting and has no equivalent typed
spelling. Never infer that two channels are the same from a question's label.

`WidgetFactory.createWidgetFromPrompt`, `buildBasicWidget`, `buildSelectOne` and `buildSelectMulti` in Android
select different controls by exact, substring and case-insensitive tests. Web Apps makes its choices in
`cloudcare/js/form_entry/entries.js::getEntry`, `buildBroadcastTopics` and `enableReceiver`.
`form_ui.js::getMatchingStyles` and `GroupedElementTileRow.calculateElementWidth` own layout. Vellum's
`parser.js::buildControlNodeAdaptorMap` recognizes a signature, field-list and phone mug by whole appearance.
These precedence rules apply **after** token composition.

**Composed settings.** Keep `reader/xform/appearances.ts` as the classifier of existing spellings. Add a typed
result describing the actual widget, modifiers and layout on each platform and the editor kind that survives
save. Select a deterministic spelling from the writer's closed recipes for those results. The reader
reclassifies the chosen spelling on the same control and bind. This checks presentation, editing, returned
answer and editor identity. The persisted exception is a named behavioral variant of the controlling setting,
such as Android-only fuzzy matching, automatic grid columns with quick advance or Web-only signature capture.
The variant has a finite discriminator and uses the existing typed parameters. No field stores an ordered bag of
tokens. Compact counts, channel arguments, the first matched per-row count and combobox's second word are inputs
to the recipe, never a global lexical sort. Enumerate recipes for conflicting widgets by the Web Apps and
Android winner pair; if there is no canonical emitting recipe for a pair, the implementation lacks that case and
its row cannot flip.

`fuzzy combobox` and `combobox fuzzy`, `quick compact-3` and `compact-3 quick`, `minimal hint-as-placeholder`
and `minimal`, and `signature 2-per-row` and `signature` are mandatory paired controls. The last pair changes
Android's image versus signature widget and Vellum's mug classification. Carry the mixed case on an image
question with Web Apps signing and a per-row setting, not by relaxing a signature question's capture contract.
The equivalent spelling classes already classified by the reader drop unread tokens, normalize harmless case or
whitespace and normalize a parseable prefixed row count only when all readers and the saved editor type agree.
Keep `minimal foo`, position-changing junk, a nonnumeric leading per-row component, an unmatched inside-token or
whitespace that changes a widget as the existing specific findings. Test an untouched field and a user changing
just the exceptional setting back to its standard value.

The Ethiopian calendar needs a paired HQ-authored date base. On Web Apps, `getEntry` calls `stylesContains`,
which compares each space-separated token to the lowercase `ethiopian`. Android's `WidgetFactory.buildBasicWidget`
compares the **entire** lowercased appearance to that word. In the base, use `ethiopian` on one date and
`ethiopian 2-per-row` on the other. Web Apps uses the Ethiopian picker on both and the two-per-row layout on the
second. Android uses the Ethiopian picker on the first and its ordinary date picker on the second. The combined
setting's platform note identifies that difference. After a Vellum save and publish-back, exercise each picker
in both runtimes and Preview. Select the same civil day and compare the submitted dates, including after removing
the row setting in Builder. An uppercase-only `ETHIOPIAN` takes the existing case-variant finding.

**Gated Web Apps behavior.** HQ `cloudcare/views.py::has_geocoder_privs` requires both `CASE_SEARCH_ADVANCED`
and `GEOCODER`. Without that pair `getEntry` constructs `UnsupportedEntry`. Represent this in the platform table
as a target condition with a satisfied and an unavailable reading, a reason and the existing publish capability
identifiers. A new document can declare the requirements. Its unbound Preview indicates the required
project-space features and offers address entry only through a working geocoder with the provider and
authorization in place. No invented address result is an answer. Use the confirmed target facts in a
target-bound Preview and both bring-in reviews. An unknown flag asks for existing deployment confirmation, a
known missing requirement stops a Web Apps publish before resource writes. Android alone reads an ordinary
entry. Local export and manual HQ files list the target requirements alongside the existing compatibility
report. An author can switch the field back to ordinary text. Cover all four truth combinations, unknown target,
Android-only and both-platform declarations. Group 6 reuses this decision for the Search screen's address input.

### Q2. Language-specific media and label content

Keep each existing shared asset slot. Add an optional per-carrier `mediaByLanguage` map keyed by the app's
language identity, using the same role names and asset types as the corresponding shared slot. The shared slot
is the source-language value where one is present. Retain an override only when the reachable language actually
shows a different asset or absence. Where the wire cannot express an explicit absence under its default
fallback, the gate disallows that combination. On a source change, relabel or removal, first materialize the old
effective language vector, then derive the new shared value and overrides by identity. Dropping one language
removes only its entries. Distinguish a navigation icon with a sparse language map from an itext media form
absent in the default locale. Two paths naming one Project asset follow today's per-deployment path ledger and
canonicalization.

Apply the model to a question's and option's supported media roles and supported help media, menu icon and
spoken name, form icon and spoken name, case-list menu item and the Register action's media. A link to a
registration form which only runs conditionally still obeys that Register action's existing media contract.
`walkAuthoredAssetRefs` must enumerate every override with language, owner identity and expected kind.
Admission, deletion checks, concurrent attachment, file budgets, same-Project filtering, local archive and both
HQ exports use that walk. Only count a physical resource once in the archive. Re-read a changed translation
asset from HQ as an ordinary localized-media mutation. Preserve an edit in one language if another editor
changes a different language.

Use `reader/menus/navMedia.ts::shownNavMedia` and `reader/xform/itext.ts` for their separate fallbacks. A
navigation map depends on HQ's default resource table, language order, profile subset and
`use_default_*_for_all`. The form depends on its default translation and per-form presence. Split
`questions/label-or-option-media-differing-by-language`. Distinct existing files and a missing target entry
inheriting a valid default are admissible. An itext media key present **only** in a nondefault locale is broken
at runtime when that locale is loaded. `XFormParser.parseIText` constructs `Localizer(true, true)`;
`getLocaleData` checks the merged keys against the default locale's own keys. The refusal is Core's
`NoLocalizedTextException`. Vellum's save can fill a missing translation, which is a different, valid input. Do
not silently make the default-language worker see a file to repair an incoming broken form. Apply the same
default-key check to each new itext form. A form's default value and the app's source language can differ.
Preserve the distinction between an inherited target-language value and an explicit override whenever a group 2
build profile or language reorder makes them observably different. Store a carrier-level default rule (`shared`,
`navigation-language-fallback` or `form-default`) and sparse explicit asset/absence entries in those cases. The
reader may collapse to the single old slot only when the projections agree for each enabled profile/language,
including after changing the language lens. Do not treat the first dictionary member as the default. Verify a
profile omitting the app's first language against `models/mixins.py::_get_media_by_language` and
`app_strings.py::create_default_app_strings`. Exercise default changes and language removal in both tools and
Builder.

A label may additionally hold extended text (`long`), inline video (a video asset), QR content (prose evaluated
in field context), and spoken text (same prose contract). Model each supported text form as its own translation
unit and respect carrier scope. Core and Formplayer source the caption from `FormEntryCaption.getLongText` and
`PromptToJson`. Markdown wins when present. Android `QuestionWidget` and `MediaLayout.buildComprehensiveLayout`
prefer inline video to QR and then the ordinary image, and offer speech when audio is absent. Web Apps ignores
inline video, QR and speech. Keep the existing refusal when HQ cannot build the first translation's label
without its default value. Prove blank, missing, inherited, differently translated and explicitly set forms, and
the precedence of two present media roles on one label. Keep install and export validation across every declared
platform.

In Builder the language selector is already the lens for worker content. Show the active file, its inherited
language when applicable, and actions to choose a file or use the shared file. The inspector groups text, QR and
speech by their worker purpose, with the local platform note next to each choice. Existing titles, option
values, XML ids and asset paths never become language names.

### Q3. A translation may show another value

A `TranslationEntry.value` already holds a `ProseTemplate`. Add an optional intentional `independent-values`
marker only to applicable translated worker prose. Ordinary translations and machine-produced suggestions keep
the source-token guarantee. An explicit human or authoring-tool edit of the value chips, or an HQ reading whose
outputs differ, selects independent values. Parse every target output at the original field site into its typed
reference or `value` expression. Validate ownership, scope, ordering and media/form requirements on that
target's own tree. Clear the marker when the multisets agree. A translation may omit, repeat or introduce a
value. Source fingerprint, review status and compare-and-set semantics remain. A change to the source which
would make the translation stale follows the existing review/fallback contract; a rename which preserves
identity must update both reference projections without forcing review.

Extend the reference index, deletion and rename guards, `slotReadRewrites`, translation admission, review/read
tools, expression context and printer to visit target-only values. The editor must show the translated chips and
let a person insert, remove or replace one in that language. A generated translation cannot remove one silently.
Evaluate each language at the same case/question/repeat scope, including protected constraint-message
reconstruction. Prove a target-only choice reference blocks deletion, an out-of-scope reference is rejected
atomically, a moved reference stays fresh after rename, and an output which is only literal text stays a
literal. Compare saved itext and the actual caption on both platforms. The optional marker and media/display
slots require no rewrite of stored documents.

## Group 4. Case lists and case details

The existing case-list workspace has Results, Details, Search and Default order. Keep the shared inventory of
columns with stable UUIDs and independent screen order. Extend its cards, the record expression editor,
`addCaseListColumns`, `updateCaseListColumn`, `configureCaseList`, `setCaseListTile` and their shared reads. A
concept with children uses addressable child UUIDs so that moving a tab or inserting an image mapping cannot
change the target of an HQ edit, a translation, or a concurrent mutation. The list continues to query Postgres
under the app and Project. Its displayed results and counts must use the same filter and order before paging.

### C1. Relation destinations, row expressions and Search results

**Relation destinations.** Introduce a case-type relation catalog keyed by origin case type and index
identifier. An entry identifies the destination type(s) and relation kind, child or extension. Reuse
`parent_type` and `relationship` as the existing single default edge. Store additional edges only where the
default cannot express them. Derive the graph from the complete set of link writers and typed loads in the app,
the existing catalog and explicit authored relationships. Re-read it once the complete app's cases and writers
are known. Never infer a destination from the first returned case row. Permit a child type to have several
parents. A backwards step keeps the originating child type, index and relationship. A forward step may have
multiple destinations. Selection, authoring suggestions, reference walks, retyping, retirement, Preview restore
and SQL need the same resolver. Group 5 consumes it for parent-menu selection, and group 7 for preloads and
writes. Group 7 resolves a write against the reached record's actual type. Known alternatives have disjoint
typed effects; an open-world write needs a common safe text or standard-facet effect.

Represent an unqualified native HQ property column as an index walk and a read of the **reached** case. With one
known destination bind the existing property identity. With several known destinations retain the set of
destination/property identities and render the value as text unless they have a common proven type. An index
with no destination declared in the app is a distinct *read* of a named child node on the reached case. Give
that read a portable property-name token and a text result, and retain a declared-type binding for each catalog
type to which it applies. Include open-world reads in dependency analysis: a typed rename or retirement which
could change one must show that dependent and either preserve its wire meaning or require its explicit edit in
the batch. Do not choose one arbitrary target or add a type predicate to an unrestricted incoming walk. In the
editor show “Related case → [index] → [property]” and identify a type where one is known. Keep typed case
properties as pairs wherever a specific case type is known. Widen numeric or date operations through an explicit
conversion, not an inferred type.

**Two narrow grammar splits.** HQ `details/utils.js::isValidPropertyName` accepts a 256-letter property and
`#other`. `PropertyXpathGenerator.xpath` rewrites `#owner_name` specifically and appends another spelling
literally. Core's `Lexer.matchNCName` has no 255-character bound and the lexer rejects the hash in `./#other`.
Admit the former in the **read** grammar and prove reads of an absent and present value. Keep existing writer
limits wherever the corresponding write is not permitted. Split the latter into a broken-runtime refusal. HQ
interpolates a tile grouping identifier into `string(./index/<name>)`. Here `site-link` and `site.link` are
single names, `site link` has invalid syntax and `parent/*` is a different path. Use group 1's portable name
table for a single XML child name. Split parse failures into broken-runtime refusals, and an actual expression
smuggled into the index-name setting into a freeform refusal. Carry the exact index identity when a grouping is
meaningful. This replaces the old two broad rows' blanket “omit”. Keep a control for each split in the
manifest's two classifiers.

**Function and expression admission.** `Expression` and its metadata in `expressionFunctions.ts` already
describe the Core vocabulary, operand cardinalities, strict versus lazy evaluation and volatility. Group 4 adds
target capabilities to the record checker, Builder cards, shared record-tool spelling and SQL compiler for
filters, cell values, tab predicates and row sets, and sorts. Consumers in groups 5, 6 and 8 opt a slot into the
targets it really uses. A display calculation is not automatically a CSQL condition. An existing list filter
sent to HQ Search still needs a valid server-search lowering on that path. Keep its unsupported branch a precise
slot finding. Classify syntax, unknown function, wrong type/cardinality, missing runtime input and nonportable
behavior separately in both the TypeScript and Python readers.

| Semantics | Implementation decision and discrimination test |
|---|---|
| Existing semantic arms | Canonicalize `if`, folded `cond`, `coalesce`, `concat`, `date`, `double`, `today`, `now`, `not`, booleans, `selected`, `starts-with`, `format-date`, relation counts and `here` to their current arms where applicable. Preserve lazy branches and clock/platform inputs. |
| Numeric and calendar | Extend the typed `call` rule for `int`, `number`, `round`, `floor`, `ceiling`, `abs`, `pow`, `min`, `max`, `sqrt`, `exp`, `log`, `log10`, `pi`, sin/cos/tan and their inverses, and `atan2`. Accept numeric operands or explicit Core casts, including numeric text and date conversion where its source class is known. Support date subtraction as elapsed days and calendar formatting with an explicit clock, zone, calendar and locale. Reuse Core's day, NaN, truncation and `floor(x+0.5)` semantics. Test positive/negative half, bad numeric text, blank, leap day, DST and more than one node. |
| Strings, selection and sequences | `string`, `string-length`, `substr`, before/after substring, `contains`, `ends-with`, `translate`, case conversion, `join`/`join-chunked`, `selected-at`, `is-selected`, `count-selected`, `index-of`, `distinct-values`, `sort` and `sort-by` use the function's declared scalar, sequence or nodeset input. Preserve document order and multiplicity, Java UTF-16 offsets/length and the runtime locale. Supply typed aggregate row scopes for `sum`, `count` and ordered joins. A position requires a real ordered node sequence and position in that sequence. Test empty sets, two values, non-BMP and Turkish text, tied keys and a missing index. A scalar filter with no sequence cannot silently produce a row number. |
| Patterns, booleans, data and location | Provide typed `regex`/`replace`, `boolean`, `boolean-from-string`, `checklist`/`weighted-checklist`, `checksum`, `id-compress`, `json-property`, `distance`, `closest-point-on-polygon` and `is-point-inside-polygon` with Core's arity, blank, stringification and error rules. SQL must implement the supported regex language and literal replacement using the same pattern semantics as Core (including search versus whole-string matching), with an explicitly enumerated common pattern grammar and a refusal for expressions outside it on a SQL-backed slot. Native `lower()`, POSIX patterns and code-point counting are not equivalence proofs. `here()` retains the existing Android-only restriction in a case list. |
| Volatile, external and special arguments | `depend` evaluates its arguments and yields the first while preserving its dependency set. A deterministic decrypt may run on a declared compatible target with a valid algorithm and typed key; wrong algorithms and invalid argument classes are refused. Core encryption uses a fresh IV, `random` and `uuid` are fresh observations, and `sleep` delays execution. Keep these out of membership/order, which must give a worker a stable count, page and selection. Retain a specific unsupported-use finding there. In display-only cells permit fresh values only with the device's actual execution semantics and without reusing them as an implicit sort or filtering input. A debug delay remains a refused performance instruction in all case views. Classify these narrowly within the broad “outside Predicate / ValueExpression” rows. |

The implementation ships a function-by-slot target table over **every** name in `FUNCTION_REGISTRY`. A row names
the argument/result kinds, the card and read spelling, whether the typed wire writer and SQL can evaluate it,
and the concrete named refusal where a target cannot. Unsupported arity, dynamic scope, nondeterministic paging,
opaque casts, a Java-only regex or an operand with no supplied instance must never become an untyped XPath
escape. Use parameterized Kysely expressions and versioned SQL helper functions for Core operations whose
semantics differ from built-ins. Execute shared input/output vectors under Core and real Postgres, including
domain errors and evaluation order. Native Core `FunctionUtils`, `XPathRoundFunc`, `XPathSubstrFunc`,
`XPathRegexFunc`, `XPathReplaceFunc` and `XPathSleepFunc` specify these distinctions. Fail any new registry row
without an explicit disposition. Retain both a new admitted example and each surviving refusal as separate
coverage classes before retiring the broad HELD-NEW rows.

**Search context.** HQ's `models/modules.py::search_detail` deep-copies the module's details and changes the
instance name. `get_details` builds the additional pair only for ordinary, non-inline Search without custom list
XML. Independent result-only detail definitions cannot survive the HQ editor. Instead give a calculated column
an optional search-result branch, both branches sharing one column identity. The record checker makes the input
UUID available in the result branch. Both exporters print one lazy choice on the case's containing roster, e.g.
`if(count(current()/../../results) > 0, <result value>, <local value>)` for the ordinary `results` roster. From
a case in the results roster the enclosing root matches. From a case in the local roster it does not. Group 6
supplies the actual roster identity for named result instances. The local branch must be well-defined with no
input instance whatsoever. Do not probe for existence by reading the missing instance. Test the guard with real
external instances, HQ-regenerated suite, both navigation paths and a missing answer.
`QueryScreen.updateSession` keeps the input instance for Formplayer; Android
`QueryRequestActivity.processSuccess` supplies only the result instance. A results-input read requires Web Apps
only. Reuse the existing inline rule for inline Search. An incoming unguarded calculation needs a reachability
proof that the local evaluation never runs, or an existing guard with that same safety. If it can throw before
Search, the finding identifies the actual column. Rewriting a broken local cell to blank without review is
outside the held class.

For an incoming native `idx/…/prop` emit the native path when it was unqualified and needed for HQ to discover
supporting rows. For a type-constrained calculation use `relatedCaseProjection.ts`'s context-relative lookup and
retain type checks. `details.py`, `models/case_list.py::get_instance_name` and
`case_search/utils.py::get_related_cases_result` determine which roster and related cases are actually
available. Group 6 owns an explicitly restricted related roster. Group 4 must respect it. An absent related
value is absent in Preview too. Never pull a supporting row from all Project cases to fill a remote result which
cannot see it, or count it as selectable.

### C2. Display columns, names and maps

A column has a source, a format and a screen position. Extend the existing discriminated column schemas where
they express each format. Keep the current default projections: a select property's normal label and Nova's
generated interval and link remain editable in their existing cards. Do not migrate any historic column into a
visually different format.

| In the workspace | Reading, emission and worker behavior |
|---|---|
| Show saved choice value | Add `showChoice: saved-value` on a plain property column. Emit `plain` and show stored tokens including stale values. Unset retains Nova's localized label projection and its existing sort key. |
| Time since, time until and late flag | Add the seven editor intervals, years/months/weeks/days since and days/weeks/months until. Use the wire coefficients including 365.25 and 365.25/12, and Core integer truncation. An HQ late flag is its own presentation on the interval source. Emit native `late-flag` with its signed threshold, including zero. Short header is empty, width 11%, and the display is `*` for a missing date or elapsed days strictly greater than threshold. Keep the long header where HQ shows it. Distinguish day exactly equal, invalid date, past and future in both platforms. |
| Text or image from mappings | Each ordered mapping has a UUID, a literal key or typed condition, and translated text or an asset with per-language alt text. Treat an empty/space-containing mapping as the actual `enum` evaluation (`selected` over the original key); different equality/contains/first-match behaviors are separate formats. HQ `models/case_list.py::MappingItem.key_as_condition` uses equality for a simple key, otherwise dot interpolation against the column source. Parse the condition, bind its subject by identity, and print it through the same wire tree. Preserve the order of overlapping rules and blank/default results. An image keyed by a literal and a conditional image both emit `enum-image`. The fixed-template Android tile can show the resource path. Web Apps reads alt text. Generated “contains any” image mappings continue to round-trip. |
| Conditional text and translated calculation | `conditional-enum` is ordered conditions over the column and translated display values. `translatable-enum` supports authored calculated text referencing its mapping variables; each variable binds to a mapping UUID and each localized value is a translation unit. Its display and sort evaluate in the chosen language. Normalize the non-calculated property spellings, including the established relation path, to a calculated variable only when the generated suite evaluates identically on each reachable roster. Preserve HQ's precedence over an authored sort comparator on a format that supplies its own. |
| Owner name and worker record | An owner-name source can read the case or a reached case's owner. HQ `PropertyXpathGenerator.owner_name` tries the matching group in `user-groups`, then the current worker's username when the worker owns it, else blank. Use group 2's worker/group fixture in Preview and preserve the unknown-owner blank. For `user/…/prop` use the worker case selected by `hq_user_id`; the generator discards intermediate steps after `user`. Canonicalize to `user/prop`, require the user-case privilege, and handle worker-case-owner access as the generator does. |
| Markdown | Keep the special link card for its existing fixed projection. A general markdown property or calculation is its own format. Escape according to the actual platform renderer, including the Android distinction between raw list rows, detail markdown and HTML handling in tiles. No interpolation of raw markup into the editor DOM. |
| Address, distance and map layers | Address identifies a map location on Android, hides the list column on Web Apps, and shows detail text there. The Web Apps map is a separate `CASE_LIST_MAP` target fact. A boundary and points each require an address in that list; a color layer additionally requires its corresponding geometry. Represent layers by their source-column UUIDs and type, short detail only. A basic/shadow detail may have one address; multiple addresses on an advanced detail retain order and Android's first-nonblank fallback. A distance cell and distance order require Android. Use `detail_screen.py::Distance`'s kilometer rounding, missing location and missing value behavior, and the worker's actual location in Preview. |
| Clickable icon | A short-detail icon has an ordered image mapping, alt text and an endpoint by stable identity. Require an existing allowed endpoint and the `CASE_LIST_CLICKABLE_ICON` and `SESSION_ENDPOINTS` capabilities. Web Apps activates it on the selected case. Android shows the path instead of the action, so declarations including Android cannot author this choice. Closing or renaming an endpoint checks these references. |

Make the source/format matrix explicit in `columnApplicability` for Results, Details, data tabs and each tile
layout. Offer an action that adds a prerequisite and the dependent item atomically (for example, address plus
boundary). Refuse a partial batch that would leave the map or endpoint relation dangling. Reference deletion,
SA/MCP descriptions and the active-language Builder inspector say which cell or mapping depends on it. Move the
existing `enum-mappingitem-alt-text-lang` and `19p-enum-image…` ambient entries to the features that now expose
those differences.

### C3. Default order

Keep existing per-column `sort` and priority. Add optional `comparator` values text, integer, decimal and
distance, omitted when equal to the effective default; date and plain compare as text in HQ's ordinary sort. A
display format with its own sort uses that key and comparator where HQ does. A distance override replaces the
sort expression while a format-specific sort can still determine the final type. Reproduce the missing distance
sentinel, sort direction, blank preference, first-header landing and translated keys in `caseListOrderPlan`,
direct suite, HQ JSON and Postgres. Probe `'2'` versus `'10'`, numeric junk, blank, ties and two distances whose
numeric and textual order differ.

Add optional ordered `calculatedSorts`, each with a UUID, a checked expression, priority, direction, effective
comparator, blanks and localized sort name. A rule whose sort is truly independent of a column becomes a row in
Default order. A sort-only **property** continues to use the existing hidden column and its name. HQ
`util.py::get_sort_and_sort_only_columns` groups a named property with its first matching column but indexes a
calculation-only rule by the calculation. Emit a calculation-only sort as `field: ''` plus `sort_calculation`
under `SORT_CALCULATION_IN_CASE_LIST`. Its hidden suite field is derived from that rule and never materializes
as an authored Results column. Join a calculated-column rule only where its expression and landing coincide, and
canonicalize duplicate source rules according to HQ's actual last-value mapping. If a matching pair would change
which implicit rule or menu name the worker sees, retain both distinct cases.

Keep `sort-rule-kept-as-hidden-column` for unmatched **property** sorts, which still use the hidden-column
representation. Narrow its detector and proof rows so it never predicts a new column for a calculation-only
rule. Keep `sort-by-entry-with-a-blank-name-dropped` for the pre-existing blank-label normalization until a
replacement stores that worker-visible entry. No ordering decision moves a hidden value into a visible Results
cell.

### C4. Details, tabs and tiles

**Tabs.** Add ordered, UUID-bearing `detailTabs`; a tab has a localized title, optional display condition and
optional row source. Each tab starts at a column UUID in the existing Details order; derive `starting_index`
from that order only when printing. Keep the first displayed field below the first tab. Moving a field across a
tab changes membership explicitly. A tab move carries its ordered contents, preserving column identities and
translations. Reject a transition with a missing start, or an empty group of columns that HQ would prune. Read
`Detail.get_tab_spans`, and print `isTab: true` so the Case Detail page saves the value as a tab. The editor can
add a populated tab in one mutation batch and moves selection/focus with it. Evaluate a tab's relevance at its
selected case even when a tab's contents show many other rows.

“Child cases” holds the child type and optional row predicate. HQ `DetailContributor._get_detail_tab_nodeset`
selects open cases of that type whose parent index equals the selected case. “Other records” holds a typed
nodeset expression with a declared row scope. A custom nodeset takes precedence over generated child settings in
HQ. The binder recognizes a row collection from the case roster, a lookup table or another supported instance
using the shared typed path vocabulary. Only ordered node collections with a resolvable per-row scope may supply
columns, sort and relevant expressions. Keep a scoped refusal for a scalar, an unresolved instance, an
unrepresentable freeform path, or an expression Core rejects in that position. Preserve physical row order and
each invisible/search-only data-tab field. SQL selects and pages real Project case rows under the outer case
identity; fixture-backed rows come from the actual fixture snapshot. Interleave two parent cases, zero and many
children, a closed child and filtered children in proof. A fixture tab needs its own input identity and instance
declaration on every path that draws it.

**Tile layouts.** Retain existing custom list grids. Add a list layout with ten *named* slots (image/text pairs
at top left, top right, middle left, middle right and bottom left). These are the keys in HQ
`suite_xml/case_tile_templates/icon_text_grid.json`. Map every slot to a distinct column UUID. Before committing
the layout, require all ten assignments and check their source formats. Keep unassigned list fields only where
real sort, search or other reader behavior needs them; never synthesize missing slot content during bring-in.
`CaseTileHelper._get_matched_detail_column` raises on a missing slot even in an advanced module. Build the setup
as a temporary local editor draft until it can emit an entire valid batch. Use a named-slot picker for this
layout. A template that was removed or is `person_simple` keeps its existing finding.

Add `detailTile` for a custom Details layout with its own cells keyed by column UUID. Results and Details may
place the same column differently. Preserve original coordinates for each tab's long-detail tile. HQ builds
separate sub-details by span. In a basic/shadow menu a shared tile row across tabs is an invalid configuration.
For an authored mixed row or second address select an advanced menu only when its navigation and actions can be
emitted there and when the ordinary advanced-placement gate admits the change. An incoming invalid basic
configuration stays a finding. Once a publish fixes the module's advanced identity, later changes use its
existing placement ledger. Support a narrow/hidden or address field with a cell: Web Apps hides it for a zero
width, Android draws a placed field on its custom list tile unless its coordinate is negative. Android renders
ordinary rows for long details. Exercise negative coordinates only on an emitted shape HQ's current editor can
keep, and retain the unplaced/hidden distinction for every other case. The test observes the cell's content,
position and visibility on each actual runtime.

**Case context above a form.** Keep the existing own-list persistence for current documents. Add optional
`contextAboveForm` with an exclusive source of another menu's tile by UUID, or a calculated one-line context
value. Project this together with the existing own-tile choice so one effective owner wins. A pull-down choice
additionally names the effective long detail of the persistent tile's source. HQ
`EntriesHelper.get_detail_persistent_attr` prefers the other menu's tile, then the local persistent tile, then
text context. `get_detail_inline_attr` uses the source menu's long detail if it can, then a local persistent
tile's long detail. `_get_persistent_case_context_detail` builds the single centered cell. Admit authored
pull-down only when a persistent tile and long detail are available and compatible with the case being shown.
When HQ stored several alternatives, preserve later fallback behavior across an edit that removes the winner
only if it changes a reachable behavior; inactive residue is classified by its own manifest row. Use
`CASE_LIST_TILE`, both custom-tile capabilities, or `SHOW_PERSIST_CASE_CONTEXT_SETTING` for the choice made.

In Preview, an ordinary detail confirms a case. A pull-down opens the form with the chosen case and the
expandable detail. Another menu supplies its display, never a newly selected case. Follow Back, next case, form
return and a source-menu rename. A dangling menu, wrong case scope or a hidden source form must fail before
publish. Protect menu deletion through `referenceIndex`. Preserve the same detail across navigation and the
existing persistent-tile rules for multiple case selection.

### C5. List text, selection, loading and Android lookup

| Choice | Author and publish rules | Preview and proof |
|---|---|---|
| Empty list and Continue wording | Add optional translated text to the list setup with translation-unit identities. Omit text equal to the effective HQ defaults in every language. Write `no_items_text` and `select_text`, the latter editable through Bulk App Translations. Empty text needs `USH_EMPTY_CASE_LIST_TEXT`; select text needs the supported minimum build version. | Web Apps shows the empty list text and labels only its multiple-selection Continue action. Android ignores both. Cover a zero-row list, a populated list, one-case confirmation and multiple selection. |
| Select every matching case | Add `autoSelect` on `selection.kind: multiple` and widen `maximum` to 1…2,147,483,647. Default remains 100. Core's suite parser uses a Java int and its stored legacy -1 is normalized to 100. A larger-than-int value is a distinct broken-runtime refusal. Existing single-select, advanced/shadow and Android restrictions stand. | `MultiSelectEntityScreen.shouldAutoSelect` uses any nonempty eligible set. An over-maximum auto-selection reports the excess and does not silently truncate. A zero match remains unselected. Test 99, 100, 101, the declared maximum and one over, including a set spanning several pages. |
| Faster loading | `caseListConfig.optimizations` enables per-calculated-column `loadBehavior` (cache, defer, both). Only address, date, markdown, phone, plain and enum calculated formats support it. A move off this format must remove the setting in the same batch or ask the author to choose. Require `CASE_LIST_OPTIMIZATIONS`; treat the separate module-wide lazy flag according to its own existing standing. | HQ `FormattedDetailColumn.fields` plus `_add_detail_optimizations` promote flags to the detail; Android's `AsyncNodeEntityFactory` distinguishes field and whole detail. Web Apps' case-list setting affects lazy loading of the whole detail, without Android's per-cell caching. Test invalidation after an edited value, first and subsequent reads, and foreground vs deferred cell resolution, using read counters/checkpoints instead of timing budgets. |
| Look up cases with an Android app | Add `caseListConfig.deviceLookup` for a plain or custom short list. Hold a nonempty action and button name, an optional icon, automatic launch, named extras with typed values, ordered response keys and an optional results column with translatable heading and checked result expression. HQ's current Case List editor requires both names and nonempty lists of extras and responses when lookup is on. Require `CASE_LIST_LOOKUP` **or** `BIOMETRIC_INTEGRATION`. Persist extra order for editing and wire output. Android evaluates and sends extras by key, and checks fallback response keys in the configured order. Resolve the icon as Project media. An enabled lookup in a fixed template with no slot is inert at that site. The Case Detail editor cannot author a long-detail lookup. | Android `EntitySelectActivity.processCalloutResult` handles returned search strings or supported identity responses, cancellation and absent matches. A direct text return trims the primary value. A null primary with the marker present takes the first non-null configured response. Fallback extras without that marker do not become text search. Route the result to the active list session, apply the actual matching/filter rules, and resolve each case/score against authorized records. On Web Apps there is no button or autolaunch. Android-mode Preview needs a device/companion handoff with a verified result channel. On a browser with no such handoff, show the requirement at the action and leave the result absent. Never populate it with made-up matches. Native proof uses a controlled result-producing Android activity. |

**Selection beyond 100 crosses a storage boundary.** Replace the duplicated hard caps in
`lib/case-store/postgres/store.ts`, `submissionEnvelope.ts`, the running selection types, request validators,
forms' iteration bindings and tool descriptions. Separate a transport page size from the configured maximum.
Small selections may still send explicit ordered IDs. Large ones use a short-lived, server-stored selection
scoped to the authenticated worker, Project, app and run. Materialize the ordered eligible IDs in one authorized
snapshot, indexed by ordinal; return a handle and count. Support paging and explicit checked/unchecked choices
without posting an unbounded ID list. Pin each selected identity to that immutable set during form processing.
Resolve it transactionally, recheck Project membership, applicable ownership/restore, existence, program
validity and the maximum before any case write. Reject an over-limit set, other tenant or expired handle
atomically. A retry of the same submission cannot reapply an already committed batch. Expiration deletes
abandoned choices; sign-out, move and ended session must not transfer a handle. This is the normal
implementation for large lists, not a deployment mechanism. Prove 101 real cases in one submission, a concurrent
changed case, rollback of the last failed operation, and no writes by another Project using the handle. Counts
and iteration preserve the order chosen by the worker.

**Lookup session fact.** Core `SessionInstanceBuilder.addUserQueryData` adds `fingerprintquery` only when the
stored selection step supplies the callout result count. Introduce a typed `case-list-lookup-count` observation
tied to its supplying selection only when **every reachable launch frame has a single possible supplier**.
Core appends one identically named node per step with a result, skips steps without one, and carries no
supplier ID in that node. When parent and child can both perform the lookup, a single returned node could
belong to either one. No positional selector can recover the supplier. For a form that reads the full
ordered observation, offer a separate typed sequence of result counts with equivalent native nodeset
semantics. Return only present counts in frame order, omitting steps that supplied none. Refuse a request for one particular supplier when call paths make the
attribution ambiguous. Recompute this rule on mirror-menu, link, form and selection edits as for
`caseListSearchTextAdmission`. Prove both results, parent only, child only and neither across a parent/child
form launched through two menus and an advanced form with additional loads. Print the existing missing-node count
guard where absence is valid. Distinguish absent, zero, one and many; use the captured selection step when the
case list has been left and its form is running. A dependent read is unavailable on Web Apps even though the
mere lookup is ignored there. The count is the size of the ordered result-key table in the selection step,
including a defined zero for an empty table. Free-text search results never synthesize this value. Test
cancellation, empty responses, two visits with different results, an uninstalled handler and a nonmatching
response. Follow Group 8's Android app callout through the same host interface once its question kind ships,
while preserving its different payload and answer.

## Delivery, evidence and removal of findings

1. Ship Q1 with its reverse decoder, kind conversion, feature/gate facts, UI and proof together. Q2 adds the
   complete language/asset projection, and Q3 adds translation-specific outputs. Group 2 supplies language and
   profile identity. A group 8 question added later reuses the already-published display checker and registry.
   Do not flip a group 8 row solely because Q1 understands an appearance on its control.
2. Ship C1's catalog, per-slot record checker and ordinary Search branch first. C2's columns use them. C3 adds
   independent sort calculations and shares order lowering with existing columns. C4 adds tabs, their row
   sources and both tile layouts, then C5 adds settings, large selection and the callout. Each admitted vertical
   slice includes `diffDocsToMutations`, undo/replay, the actual editor save, HQ change detection, publication
   to the original target and export to a new one. Reuse existing identity mapping for the same column across
   the two details and append stable tab/mapping/sort identities to matching and diffing. An ambiguous HQ edit
   must stop with its subject rather than combining two columns.
3. These document changes use optional fields and wider reading grammars. Existing documents keep their prior
   projection and hold no new field by default. New tables for the temporary worker-selection data ship in
   ordinary Kysely migrations. There is no document maintenance cutover for these groups as designed. Keep all
   durable implementation choices in their subtree contracts and public Builder, language, Preview, multi-select
   and publishing guides. Update the model context version, generated platform guide, tool schemas, served MCP
   descriptions and plugin instructions when the contracts first change.
4. Anchor an HQ-authored base per palette control and per column and tab kind. Extend the multilingual base with
   different files, an inherited target-language file, sparse navigation media, profile restrictions and
   target-only outputs. Keep the missing default itext key as a broken-runtime control. Extend the list base
   with two adjacent differently formatted columns over the same property, tabs with actual child rows, three
   layouts and independently observable sort results. Use genuine Vellum save and Case List/Detail + Bulk App
   Translations save, import/build, Core, Formplayer, the browser and Android. Each move from `HELD-NEW` to
   `HELD` needs an exhibited base and the independently implemented Python value-class/TypeScript reader
   agreement. For a split refusal, its malformed or out-of-envelope control remains a refusal variant; an
   admitted neighboring class gets its own base. Keep proofs 1–6 and an HQ-edit → bring-in → publish-back
   journey for every slice. This is work for the implementing PRs, not evidence of implementation.
5. Record pairs of observables, not just screenshots: active widget plus persisted answer; per-language asset
   identity plus delivered bytes; tab label plus visible case IDs; list membership plus sort order plus value in
   a localized cell; native lookup activity plus authorized result count. Read the value on both reachable
   platforms. For ignored/unavailable differences, show the ordinary widget/absence of the action, or
   demonstrate the closed gate. Update `PLATFORM_FEATURES`, platform uses, `platformFeatureEntries.ts`, Preview
   cells/fixtures, builder picker and migration-notice/refusal copy in the same slice. Exercise mobile
   navigation, keyboard editing, active language and undo in Playwright at the normal Builder entry points.
6. Preserve existing narrow first-publish declarations for unrelated transformations. In particular
   `media-files-renamed`, `media-paths-joined` and `media-maps-respelled` can still occur for path spelling,
   allocation or fallback. `unshown-form-media-removed` still applies to media on unshown carriers. A localized
   file, extra text value, new column format, independent calculation or tile which the reader now holds exactly
   must never trigger a notice predicting its deletion. Update the per-site predicates in
   `lib/deployment/reading/firstPublishChanges.ts`, their withheld rewrites and
   `proof/first-publish-changes.json`, with positive witnesses for other surviving sites. Keep old stored change
   IDs readable. Both group exits assert zero owned HELD-NEW entries and zero owned circumstances, including the
   newly split classes.


## Row index

Each entry below belongs to one of the slices above. The platform cells reproduce the current manifest readings.
A conditional reading or split has the disposition specified in its slice. “n/a” marks an original
classification which did not describe a runtime cell. The name-grammar splits in C1 replace those cells for
admitted values.

### Question display (63 entries)

| Manifest entry | Slice | Web Apps | Android |
|---|---|---|---|
| `forms-and-case-writes/media-image-media-audio-differing-by-language` | Q2 | runs | runs |
| `menus-and-case-lists/media-image-media-audio-differing-by-language` | Q2 | runs | runs |
| `questions/select1-minimal` | Q1 | runs | runs |
| `questions/select1-compact-compact-n` | Q1 | ignored | runs |
| `questions/select1-quick` | Q1 | ignored | runs |
| `questions/select1-quick-compact-n` | Q1 | ignored | runs |
| `questions/select1-combobox` | Q1 | runs | runs |
| `questions/select1-combobox-multiword` | Q1 | different | runs |
| `questions/select1-combobox-fuzzy` | Q1 | different | runs |
| `questions/select1-list` | Q1 | ignored | runs |
| `questions/select1-list-nolabel` | Q1 | runs | runs |
| `questions/select1-label` | Q1 | runs | runs |
| `questions/select1-button-select` | Q1 | runs | ignored |
| `questions/select1-receive-topic-field` | Q1 | runs | ignored |
| `questions/select-minimal` | Q1 | runs | runs |
| `questions/select-compact-compact-n` | Q1 | ignored | runs |
| `questions/select-list` | Q1 | ignored | runs |
| `questions/select-list-nolabel` | Q1 | runs | runs |
| `questions/select-label` | Q1 | runs | runs |
| `questions/secret-numeric` | Q1 | different | runs |
| `questions/text-secret-numbers` | Q1 | ignored | runs |
| `questions/short` | Q1 | runs | different |
| `questions/medium` | Q1 | runs | ignored |
| `questions/text-address` | Q1 | runs with both gates, otherwise unavailable | ignored |
| `questions/broadcast-topic-an-address-entry-under-the-gates-above-and` | Q1 | runs | ignored |
| `questions/text-receive-topic-field` | Q1 | runs | ignored |
| `questions/barcode-numeric-address-or-receive-topic-field` | Q1 | different | ignored |
| `questions/hint-as-placeholder-on-text-other-than-a-secret-without-numeric` | Q1 | runs | ignored |
| `questions/hint-as-placeholder-on-any-other-entry` | Q1 | different | ignored |
| `questions/barcode-quick` | Q1 | ignored | runs |
| `questions/date-ethiopian` | Q1 | runs | runs |
| `questions/date-nepali` | Q1 | ignored | runs |
| `questions/date-gregorian-gregorian-cancel` | Q1 | ignored | runs |
| `questions/time-12-hour` | Q1 | runs | ignored |
| `questions/geopoint-maps` | Q1 | ignored | runs |
| `questions/barcode-editable` | Q1 | ignored | runs |
| `questions/image-acquire` | Q1 | ignored | runs |
| `questions/image-overlay-small` | Q1 | ignored | runs |
| `questions/audio-legacy` | Q1 | ignored | runs |
| `questions/audio-acquire-or-upload` | Q1 | ignored | runs |
| `questions/audio-long` | Q1 | ignored | runs |
| `questions/video-acquire` | Q1 | ignored | runs |
| `questions/trigger-selectable` | Q1 | ignored | runs |
| `questions/floating-good-floating-caution-floating-bad` | Q1 | ignored | runs |
| `questions/a-label-whose-appearance-string-starts-with-floating-other-than` | Q1 | ignored | different |
| `questions/group-compact` | Q1 | ignored | runs |
| `questions/group-group-collapse` | Q1 | runs | ignored |
| `questions/group-collapse-open` | Q1 | runs | ignored |
| `questions/group-group-border` | Q1 | runs | ignored |
| `questions/n-per-row-any-question-or-group-other-than-a-vellum-repeat-n-one` | Q1 | runs | ignored |
| `questions/n-per-row-repeat-group-with-a-repeat-as-a-direct-child-n-one-or` | Q1 | runs | ignored |
| `questions/any-other-per-row-token-the-first-token-web-apps-per-row-pattern` | Q1 | runs | ignored |
| `questions/text-align-center-text-align-right` | Q1 | runs | ignored |
| `questions/multi-token-strings-e-g-minimal-hint-as-placeholder-signature-2` | Q1 | different | different |
| `questions/a-multi-token-string-holding-tokens-no-runtime-reads-on-that` | Q1 | different | different |
| `questions/a-single-string-no-row-names-that-holds-values-android-matches` | Q1 | ignored | runs |
| `questions/a-case-variant-of-numbers-nepali-or-maps-of-video-acquire-or-of` | Q1 | ignored | runs |
| `questions/long-form` | Q2 | runs | runs |
| `questions/label-or-option-media-differing-by-language` | Q2 | runs | runs |
| `questions/label-video-inline` | Q2 | ignored | runs |
| `questions/label-qrcode` | Q2 | ignored | runs |
| `questions/label-tts` | Q2 | ignored | different |
| `questions/a-text-whose-languages-show-different-values` | Q3 | runs | runs |

### Case lists and details (61 entries)

| Manifest entry | Slice | Web Apps | Android |
|---|---|---|---|
| `expressions-and-data/session-data-fingerprintquery` | C5 | unavailable | runs |
| `expressions-and-data/search-input-results-read-in-the-search-results-detail` | C1 | runs | unavailable |
| `menus-and-case-lists/module-show-case-list-optimization-options` | C5 | different | runs |
| `menus-and-case-lists/detail-filter-value-outside-predicate` | C1 | runs | runs |
| `menus-and-case-lists/detail-auto-select-multi-select` | C5 | runs | unavailable |
| `menus-and-case-lists/detail-max-select-value-above-100` | C5 | runs | unavailable |
| `menus-and-case-lists/detail-case-tile-template-icon-text-grid` | C4 | runs | different |
| `menus-and-case-lists/long-detail-custom-tile-case-detail-laid-out-as-a-tile` | C4 | runs | ignored |
| `menus-and-case-lists/detail-persistent-case-tile-from-module` | C4 | runs | runs |
| `menus-and-case-lists/detail-pull-down-tile` | C4 | runs | runs |
| `menus-and-case-lists/case-tile-group-identifier-outside-an-xml-element-name` | C1, C4 | n/a | n/a |
| `menus-and-case-lists/detail-persist-case-context-persistent-case-context-xml` | C4 | runs | runs |
| `menus-and-case-lists/detail-no-items-text-other-than-hq-s-default-en-list-is-empty` | C5 | runs | ignored |
| `menus-and-case-lists/detail-select-text-non-default` | C5 | different | ignored |
| `menus-and-case-lists/column-field-outside-nova-s-property-grammar` | C1 | n/a | n/a |
| `menus-and-case-lists/usexpathexpression-field-xpath-outside-valueexpression` | C1 | runs | runs |
| `menus-and-case-lists/enum-mappingitem-alt-text-non-blank` | C2 | runs | ignored |
| `menus-and-case-lists/case-tile-field-template-slot-on-icon-text-grid` | C4 | runs | different |
| `menus-and-case-lists/optimization-cache-lazy-load-cache-and-lazy-load` | C5 | different | runs |
| `menus-and-case-lists/1p-plain-over-a-property-select-questions-write` | C2 | runs | runs |
| `menus-and-case-lists/3-time-ago-time-ago-interval-the-7-menu-values-years-months` | C2 | runs | runs |
| `menus-and-case-lists/5pp-enum-key-that-is-empty-or-holds-whitespace` | C2 | runs | runs |
| `menus-and-case-lists/translatable-enum-on-a-column-that-is-not-a-calculated-property-over-a-property` | C2 | runs | runs |
| `menus-and-case-lists/translatable-enum-on-a-column-that-is-not-a-calculated-property-relation-does` | C2 | runs | runs |
| `menus-and-case-lists/6-late-flag-late-flag-1` | C2 | runs | runs |
| `menus-and-case-lists/6p-late-flag-late-flag-0` | C2 | runs | runs |
| `menus-and-case-lists/invisible-or-address-column-in-a-custom-tile` | C4 | runs | different |
| `menus-and-case-lists/7pp-invisible-inside-a-data-tab-over-a-nodeset` | C4 | runs | runs |
| `menus-and-case-lists/8-address` | C2 | different | runs |
| `menus-and-case-lists/9-distance` | C2 | unavailable | runs |
| `menus-and-case-lists/10-markdown-outside-the-link-shape` | C2 | runs | different |
| `menus-and-case-lists/11-geo-boundary` | C2 | ignored | runs |
| `menus-and-case-lists/12-geo-boundary-color-on-the-case-list-only-needs-an-address` | C2 | ignored | runs |
| `menus-and-case-lists/13-geo-points-on-the-case-list-only` | C2 | ignored | runs |
| `menus-and-case-lists/14-geo-points-colors-on-the-case-list-only-needs-an-address` | C2 | ignored | runs |
| `menus-and-case-lists/16-clickable-icon-endpoint-action-id-on-the-case-list` | C2 | runs | unavailable |
| `menus-and-case-lists/19-enum-image-whose-keys-are-plain-values` | C2 | runs | different |
| `menus-and-case-lists/19pp-enum-image-whose-keys-are-conditions-of-any-other-form-dot` | C2 | runs | different |
| `menus-and-case-lists/20-conditional-enum` | C2 | runs | runs |
| `menus-and-case-lists/21-translatable-enum-outside-nova-s-two-projections` | C2 | runs | runs |
| `menus-and-case-lists/more-than-one-address-column-in-a-detail-of-an-advanced-module` | C2 | runs | different |
| `menus-and-case-lists/idx-prop-in-a-menu-that-offers-search-or-through-an-index` | C1 | runs | runs |
| `menus-and-case-lists/user-prop-usercase` | C2 | runs | runs |
| `menus-and-case-lists/user-steps-prop` | C2 | runs | runs |
| `menus-and-case-lists/owner-name` | C2 | runs | runs |
| `menus-and-case-lists/type-int-or-double-differing-from-the-derived-type-on-a-column` | C3 | runs | runs |
| `menus-and-case-lists/type-plain-date-or-string-or-none-where-nova-derives-int-or-double` | C3 | runs | runs |
| `menus-and-case-lists/type-distance` | C3 | unavailable | runs |
| `menus-and-case-lists/sort-calculation-authored-calculation-row-field` | C3 | runs | runs |
| `menus-and-case-lists/plain-tab-header-starting-index` | C4 | runs | runs |
| `menus-and-case-lists/tab-relevant-lifts-into-predicate-not` | C4 | runs | runs |
| `menus-and-case-lists/data-tab-over-child-cases-has-nodeset-nodeset-case-type-nodeset` | C4 | runs | runs |
| `menus-and-case-lists/data-tab-over-a-custom-nodeset-xpath` | C4 | runs | runs |
| `menus-and-case-lists/a-custom-long-tile-row-mixing-fields-of-two-tabs-in-an-advanced` | C4 | runs | runs |
| `menus-and-case-lists/lookup-enabled-lookup-action` | C5 | ignored | runs |
| `menus-and-case-lists/lookup-name` | C5 | ignored | runs |
| `menus-and-case-lists/lookup-image-jr` | C5 | ignored | runs |
| `menus-and-case-lists/lookup-autolaunch` | C5 | ignored | runs |
| `menus-and-case-lists/lookup-extras-key-value` | C5 | ignored | runs |
| `menus-and-case-lists/lookup-responses-key` | C5 | ignored | runs |
| `menus-and-case-lists/lookup-display-results-lookup-field-header-lookup-field-template` | C5 | ignored | runs |
