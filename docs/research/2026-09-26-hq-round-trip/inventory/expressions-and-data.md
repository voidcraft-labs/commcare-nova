# Expressions and data

Part of the surface inventory of the HQ round-trip research. Section names in quotes and defect numbers refer to the main document, [`../README.md`](../README.md). Rows that point elsewhere with `→` name the section that owns the item; the inventory [`README.md`](README.md) says which file holds each section.

## Secondary instances

Runtime dispatch is by `src`, in order ledgerdb → casedb → fixture → session (substring tests) → remote → selected-entities → search-input (prefix tests) (`CommCareInstanceInitializer::generateRoot`). Nova's form logic admits the `casedb` and `commcaresession` instances and lookup fixtures (through its typed lookup carriers) today; each HELD-NEW row adds its instance to the typed expression model as an identity-bearing reference.

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| `casedb` (`jr://instance/casedb`) | **HELD**: casedb reads (typed `#<type>/prop` leaves today; queries become typed case-database references) | RUNS / RUNS | `instance('casedb')` |
| `commcaresession` (`jr://instance/session`) | **HELD**: session reads (`session-user`/`session-context` terms; datum names as held identity, and datum reads in the typed session reference below) | DIFFERENT (context fields below) / RUNS | `instance('commcaresession')` |
| session `data/<datum>` | **HELD-NEW**: typed session reference | RUNS / RUNS | path |
| session `data/supply_point_id` | **REFUSED**: retiring (COMMTRACK): HQ supplies that datum only in a CommTrack project space (`entries.py::entry_for_module`) | — | — |
| session `data/stringquery` | **HELD-NEW**: typed session reference | UNAVAILABLE (node absent) / RUNS | path |
| session `data/fingerprintquery` | **HELD-NEW**: typed session reference | UNAVAILABLE / RUNS | path |
| session `context/userid`, `context/username` | **HELD**: `session-context` | RUNS / RUNS | path |
| session `context/deviceid` | **HELD**: `session-context` | DIFFERENT (`Formplayer`) / RUNS | path |
| session `context/appversion` | **HELD**: `session-context` | DIFFERENT (`Formplayer Version: X.Y`) / RUNS | path |
| session `context/drift` | **HELD-NEW**: typed session reference | DIFFERENT (always 0) / RUNS | path |
| session `context/window_width` | **HELD-NEW**: typed session reference | DIFFERENT (first render only) / UNAVAILABLE | path |
| session `context/applanguage` | **HELD-NEW**: typed session reference | DIFFERENT (unreliable after first render) / RUNS | path |
| session `user/data/<field>` | **HELD**: `session-user` / `user-ref` | RUNS / RUNS | path |
| `ledgerdb` (Vellum id `ledger`) | **REFUSED**: retiring (COMMTRACK): ledger data exists only from COMMTRACK-authored ledger blocks or a `commtrack_enabled` restore | — | — |
| `item-list:<tag>` read through Nova's typed lookup carriers | **HELD**: lookup options / `table-lookup` | RUNS / RUNS | bare-tag XForm id, `item-list:<tag>` in the suite |
| `item-list:<tag>` read in any other expression | **HELD-NEW**: typed lookup-table reference bound to the Project table, its fields and properties | RUNS / RUNS | same |
| `groups` (`jr://fixture/user-groups`) | **HELD-NEW**: typed reference to the case-sharing groups fixture | RUNS / RUNS | `instance('groups')` |
| `locations` (flat, `jr://fixture/locations`) read in an expression | **HELD-NEW**: typed location reference (today only typed owner terms); with `project_default`, which Nova writes once defect 14 is fixed, and today writes `both_fixtures`, the restore both runtimes receive follows the project space's stored setting (`locations/fixtures.py::should_sync_flat_fixture`), which publish confirms | RUNS / RUNS | `instance('locations')` |
| `commtrack:locations` (hierarchical) | **REFUSED**: retiring (HIERARCHICAL_LOCATION_FIXTURE) | — | — |
| `reports`, `commcare:reports`, `commcare-reports:*`, `commcare-reports-filters:*` | **REFUSED**: retiring (MOBILE_UCR) | — | — |
| `registry` (`jr://instance/remote/registry`) | **REFUSED**: retiring (DATA_REGISTRY) | — | — |
| `results`, `results:inline`, `results:<name>` in search details | **HELD**: search result details | RUNS / RUNS | as HQ generates |
| `results*` read in form expressions of an inline-search module | **HELD-NEW**: typed search-result reference | RUNS / RUNS (UNAVAILABLE for results not on the device) | path |
| `results*` read in form expressions reached through a search that is not inline | **REFUSED**: broken at runtime: the search's `<rewind>` (`remote_requests.py::RemoteRequestFactory.build_stack`) drops the query step (`SessionFrame.rewindToMarkAndSet`), so the form finds no source for the instance (`CommCareInstanceInitializer.setupExternalDataInstance`) and every read throws "Instance referenced by … has not been loaded" (`XPathPathExpr`), on both runtimes | — | — |
| `search-input:results[:…]`, and legacy `search-input`, read while the query is built | **HELD**: search input reads (Nova emits them in CSQL) | RUNS / RUNS (both evaluate them through `RemoteQuerySessionManager.getEvaluationContextWithUserInputInstance`) | path |
| `search-input:results[:…]` read in the search results detail | **HELD-NEW**: a typed search-input reference (typed expression model) | RUNS / UNAVAILABLE (Formplayer keeps the inputs, `QueryScreen.updateSession`; Android sets only the results on the query step, `QueryRequestActivity`, so a read throws) | path |
| legacy `search-input` read after the query (in the results detail or a form) | **REFUSED**: broken at runtime: HQ never declares `jr://instance/search-input` (`suite_xml/post_process/instances.py::InstancesHelper.IGNORED_INSTANCES`), and Core provides the bare id only while it builds the query (`RemoteQuerySessionManager.getEvaluationContextWithUserInputInstance`), so every later read fails on both runtimes | — | — |
| `search-input:*` read in form expressions of an inline-search module | **HELD-NEW**: typed search-input reference | RUNS / UNAVAILABLE | path |
| `search-input:*` read in form expressions reached through a search that is not inline | **REFUSED**: broken at runtime: the `<rewind>` drops the step that carries the inputs, so every read throws "has not been loaded" (HQ's "Make search input available after search" checkbox is inline search itself, `remote_requests.py`) | — | — |
| `selected_cases`, `search_selected_cases`, `parent_…selected_cases*` (`jr://instance/selected-entities/<id>`) | **HELD**: multi-select | RUNS / UNAVAILABLE | ids as HQ derives them |
| `schedule:m…:p…:f…` | **REFUSED**: retiring (VISIT_SCHEDULER) | — | — |
| `indicators:*` (call-center indicators) | **REFUSED**: untypeable: its rows come from the target's call-center configuration, which Nova cannot read | — | — |
| `commtrack:products`, `commtrack:programs` | **REFUSED**: retiring (COMMTRACK) | — | — |
| `case-search-fixture:*` | **REFUSED**: retiring (CSQL_FIXTURE) | — | — |
| inline instance (content inside `<instance>`, no `src`) | **REFUSED**: freeform | — | — |
| declared and referenced instance with an unrecognized `src` | **REFUSED**: broken at runtime: resolves to `ConcreteInstanceRoot.NULL`; every read throws "has not been loaded" (`XPathPathExpr`) | — | — |
| referenced, undeclared instance id with no known scheme, or one whose factory returns none (`results:<unknown>`, `search-input:results:<unknown>`, `commcare:reports` without MOBILE_UCR) | **REFUSED**: not HQ-buildable: `UnknownInstanceError` / "missing some instance declarations" | — | — |
| declared, unreferenced instance whose source loads no data (`casedb`, session, remote, search-input, selected entities, or an unrecognized source) | **INERT**: no reader, and initializing it cannot fail | n/a | omit |
| declared, unreferenced fixture instance (`item-list:*`, `locations`, `user-groups`) the project space serves | **INERT**: Core initializes every declared instance when the form opens (`ExternalDataInstance.initialize` → `CommCareInstanceInitializer.generateRoot`), which succeeds here, and nothing reads it | n/a | omit |
| declared, unreferenced fixture instance the project space does not serve | **REFUSED**: broken at runtime: initializing it throws `FixtureInitializationException` when the form opens (`CommCareInstanceInitializer.loadFixtureRoot`; executed), so the form cannot open | — | — |
| more than one `<instance>` without an `id` | **REFUSED**: not HQ-editable: Vellum refuses to open (`parser.js::_getInstances`) | — | — |
| menu `<instance>` declarations | **HELD**: derived by HQ from module filters | RUNS / RUNS | nothing |

## XPath functions and structure

Every JavaRosa call name is admitted in Nova's `XPathExpression` slots today (`lib/commcare/xpath/functionCapabilities.ts::JAVAROSA_NATIVE_FUNCTIONS` = `ASTNodeFunctionCall.buildFuncExpr`, 76 names; Preview executes all). In the typed expression model each is a typed node; the platform cells give each function's reading on Web Apps and Android.

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| `abs` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `acos` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `asin` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `atan` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `atan2` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `boolean` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `boolean-from-string` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `ceiling` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `checklist` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `checksum` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `closest-point-on-polygon` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `coalesce` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `concat` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `cond` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `contains` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `cos` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `count` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `count-selected` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `date` | **HELD-NEW**: a typed function node | RUNS / RUNS (string parsing identical; number→date: see `number`) | printed |
| `decrypt-string` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `depend` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `distance` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `distinct-values` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `double` | **HELD-NEW**: a typed function node | DIFFERENT (on a date: fraction is server-zone wall time) / RUNS | printed |
| `encrypt-string` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `ends-with` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `exp` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `false` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `floor` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `format-date` | **HELD-NEW**: a typed function node | RUNS / RUNS (English names on both) | printed |
| `format-date-for-calendar` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `id-compress` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `if` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `index-of` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `int` | **HELD-NEW**: a typed function node | DIFFERENT (on a date: day number anchored to the formplayer JVM zone, Etc/UTC) / RUNS | printed |
| `is-point-inside-polygon` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `is-selected` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `join` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `join-chunked` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `json-property` | **HELD-NEW**: a typed function node | DIFFERENT (non-string values → `""`) / DIFFERENT (framework `org.json` stringifies) | printed |
| `log` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `log10` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `lower-case` | **HELD-NEW**: a typed function node | DIFFERENT (server JVM locale) / DIFFERENT (device locale) | printed |
| `max` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `min` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `not` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `now` | **HELD-NEW**: a typed function node | DIFFERENT (server clock; calculates re-run every request) / RUNS (device clock) | printed |
| `number` | **HELD-NEW**: a typed function node | DIFFERENT (on a date: JVM-zone anchor) / RUNS | printed |
| `pi` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `position` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `pow` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `random` | **HELD-NEW**: a typed function node | DIFFERENT (a calculate changes every request) / RUNS | printed |
| `regex` | **HELD-NEW**: a typed function node | DIFFERENT (ASCII classes) / DIFFERENT (Unicode classes; named groups need API 26) | printed |
| `replace` | **HELD-NEW**: a typed function node | DIFFERENT / DIFFERENT (as `regex`) | printed |
| `round` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `selected` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `selected-at` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `sin` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `sleep` | **HELD-NEW**: a typed function node | DIFFERENT (delays every request) / RUNS (only when a dependency changes) | printed |
| `sort` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `sort-by` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `sqrt` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `starts-with` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `string` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `string-length` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `substr` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `substring-after` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `substring-before` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `sum` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `tan` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `today` | **HELD-NEW**: a typed function node | DIFFERENT (server clock, browser zone) / RUNS (device clock and zone) | printed |
| `translate` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `true` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `upper-case` | **HELD-NEW**: a typed function node | DIFFERENT / DIFFERENT (as `lower-case`) | printed |
| `uuid` | **HELD-NEW**: a typed function node | DIFFERENT (a calculate changes every request) / RUNS | printed |
| `weighted-checklist` | **HELD-NEW**: a typed function node | RUNS / RUNS | printed |
| `instance('id')`, `current()` path roots | **HELD-NEW**: typed path roots (path initializers, `XPathPathExpr.getReference`; the `casedb` and `commcaresession` roots are held today, Secondary instances) | RUNS / RUNS | printed |
| `jr:itext('id')` | **HELD-NEW**: itext lookup bound to a translation unit (not in Nova's registry today) | RUNS / RUNS | printed |
| `jr:choice-name(value, 'path')` on a static-choice select | **HELD-NEW**: choice-label lookup bound to the field | RUNS / RUNS | printed |
| `jr:choice-name` on a lookup (itemset) select | **REFUSED**: broken at runtime: "error in evaluation of xpath function [choice-name]" on both | — | — |
| `here()` in a form | **REFUSED**: broken at runtime: no form-context handler ("cannot handle function 'here'") | — | — |
| `here()` in a case-list calculated column or sort | **HELD-NEW**: row-context `here()` | UNAVAILABLE in case-list rows and sorts (Core's São Paulo placeholder, `EntityScreen`), RUNS in the case detail with the browser's location, blank until granted (`MenuSessionRunnerService`, `FormplayerHereFunctionHandler`) / RUNS | printed |
| any other function name | **REFUSED**: broken at runtime: `XPathCustomRuntimeFunc` throws at evaluation | — | — |
| union `a \| b` | **REFUSED**: broken at runtime: `XPathUnionExpr` throws "nodeset union operation" | — | — |
| filter expression `(expr)[…]` (root other than `instance()`/`current()`) | **REFUSED**: broken at runtime: `XPathUnsupportedException("filter expression")` (followed by a path step in a bind, not HQ-buildable: Core's parse refuses it) | — | — |
| `//`, and axes other than `child::` name or `*`, `attribute::` name, `self::node()`, `parent::node()` | **REFUSED**: not HQ-buildable in a bind, where Core's parse refuses it ("step other than 'child::name', '.', '..'", `XPathPathExpr.getReference`); broken at runtime in an output or setvalue | — | — |
| `..` after a named step (`/data/a/../b`) | **REFUSED**: not HQ-buildable in a bind, where Core's parse refuses it; broken at runtime in an output or setvalue: parents are not allowed after a named step | — | — |
| `$var` in a form expression | **REFUSED**: broken at runtime: form contexts define no variables, so a bare `$var` reads blank and any function or operator over it throws (executed) | — | — |
| `<`, `<=`, `>` or `>=` with a time on either side (a time answer, property or string) | **REFUSED**: broken at runtime: Core compares both sides as numbers, and a string holding `:` is NaN (`FunctionUtils.toNumeric`; a time answer reaches XPath as its string, `XPathPathExpr.unpackValue`), so the comparison is always false (executed: `'14:30' < '15:00'` is false) | — | — |
| relative paths (`../q`, `.`, `current()/../x`) | **HELD-NEW**: typed expression model: relative paths bound as identity leaves, so renames rewrite them (admitted as opaque text today) | RUNS / RUNS | printed |
| `#form/…` | **HELD**: `field-ref` | RUNS / RUNS | hashtag + expanded path; in a default value, the read printed relatively (defect 13) |
| `#case/<prop>`, `#case/parent/<prop>`, `#case/grandparent/<prop>` | **HELD**: `#<type>/<prop>` identity leaves for the module, parent and grandparent types | RUNS / RUNS | HQ hashtags + expanded paths, the `#case/parent/` or `#case/grandparent/` hashtag only where HQ's parent-type map gives the case type that ancestor (`app_schemas/case_properties.py::get_parent_type_map`, from basic child-case actions and indexed advanced open actions in the app and its case-sharing apps), and otherwise the expanded path alone: a Vellum save writes a hashtag its schema does not know into the XForm unexpanded, which Core cannot parse, and keeps an expanded path (executed; Nova writes these hashtags today, `lib/commcare/hashtags.ts`) |
| `#case:<module-slug>/…` (unrelated parent-select case) | **REFUSED**: retiring (NON_PARENT_MENU_SELECTION: only "Other" parent selection produces it) | — | — |
| `#registry_case/…` | **REFUSED**: retiring (DATA_REGISTRY) | — | — |
| `#user/<prop>` | → Usercase, `#user/<prop>` | — | — |
| `#session/…` (HQ shorthand in navigation slots) for the context and user paths Nova holds | **HELD** | RUNS / RUNS | expanded `instance('commcaresession')/session/…` path |
| `#session/data/<datum>` (HQ shorthand in navigation slots) | **HELD-NEW**: typed session datums | RUNS / RUNS | expanded `instance('commcaresession')/session/…` path |
| an invalid XPath in a bind attribute | **REFUSED**: not HQ-buildable: JavaRosa fatal | — | — |

## Media

A media file is held when every platform the app declares plays it, and HQ types it as the same kind (image, audio or video); Nova's Preview plays what the browser plays and shows a stand-in, naming the file, for one only Android plays. The platform facts come from the vendors' documentation, not from playback tests: Android from Google's supported media formats (developer.android.com/media/platform/supported-formats, decoder columns, at Android 6.0, CommCare's minimum, `minSdkVersion 23`, since CommCare plays media with Android's own `MediaPlayer` and `VideoView`); Web Apps from the current releases of Chrome, Edge, Firefox and Safari, per Chromium's codec list (chromium.org/audio-video), MDN's image, audio codec, video codec and container guides (developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats), and Apple's archived Safari audio and video guide (developer.apple.com/library/archive, Using HTML5 Audio and Video), where MDN's current compatibility data takes precedence over it.

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| image PNG, JPEG, GIF, WebP | **HELD**: `lib/media` image asset | RUNS / RUNS (GIF animates only via Glide on `.gif`) | bytes via the multimedia API |
| image BMP | **HELD**: widen: add BMP (needs a non-`sharp` body parser) | RUNS / RUNS | same |
| image ICO, SVG, AVIF | **HELD-NEW**: an image asset for an app that does not declare Android (every browser in the bar plays them; Android 6.0 does not decode them, AVIF only from Android 14); an SVG is shown only as an image, where a browser runs none of its script | RUNS / UNAVAILABLE | same |
| image TIFF, HEIF | **REFUSED**: broken at runtime: neither platform plays them on every device or browser it runs on (MDN documents TIFF for Safari alone and does not list HEIF; Android decodes neither at 6.0, HEIF only from 8.0) | — | — |
| audio MP3, AAC in M4A (brand `M4A `/`M4B `), FLAC, PCM WAV (8- or 16-bit) | **HELD** (MP3, WAV; narrow: PCM 8- or 16-bit only, Nova checks no WAV encoding today) and **HELD** widen (M4A with a brand check, FLAC): audio asset | RUNS / RUNS | same |
| audio WAV that is not 8- or 16-bit PCM | **REFUSED**: broken at runtime: Android plays only 8- and 16-bit PCM WAV (Google's supported formats), and MDN documents support for other WAV codecs only as sparse | — | — (Nova accepts WAV of any encoding today: defect 11) |
| audio Ogg Vorbis or Opus | **HELD**: widen: add Ogg Vorbis and Opus to the audio set | RUNS (Safari since 18.4) / RUNS | same |
| audio raw AAC (ADTS, `.aac`), AMR, MIDI | **HELD-NEW**: an audio asset for an app that does not declare Web Apps (Chrome plays AAC only inside MP4; no browser plays AMR or MIDI) | UNAVAILABLE / RUNS | same |
| audio M4A with another brand (`isom`, `mp41`, `mp42`, `dash`) | **REFUSED**: broken at runtime: HQ classifies it as video, so an audio reference never receives the bytes (`CommCareMultimedia.get_class_by_data`) | — | — |
| audio 3GP | **REFUSED**: broken at runtime: HQ classifies it as video | — | — |
| video MP4 H.264 Baseline or Main, with AAC-LC or no audio; WebM VP8 or VP9, with Vorbis, Opus or no audio | **HELD** (MP4; narrow: Nova checks no codec today) and **HELD** widen (WebM): video asset | RUNS / RUNS | same |
| video MP4 H.264 High | **HELD-NEW**: a video asset for an app that does not declare Android (Android 6.0 guarantees only Baseline and Main) | RUNS / UNAVAILABLE | same |
| video HEVC (MP4), MPEG-4 Part 2 (MP4), and MKV holding a codec Android plays | **HELD-NEW**: a video asset for an app that does not declare Web Apps (Chrome plays HEVC only with hardware support, no browser MPEG-4 Part 2 in MP4 (Firefox plays it only in 3GP), and Chrome alone MKV) | UNAVAILABLE / RUNS | same |
| video AV1, MOV, AVI, Ogg Theora, H.263 (3GP) | **REFUSED**: broken at runtime: no platform in the bar plays them everywhere (AV1 needs Android 10 and hardware in Safari; Android plays no MOV or AVI, and Firefox no MOV; no current browser plays Theora or H.263, and Android makes H.263 optional from 7.0) | — | — |
| an imported asset larger than Nova's per-kind cap, or an app whose media exceeds Nova's export budget (500 files / 200 MiB) | **HELD-NEW**: import-sized media: HQ imposes no size cap, so the caps govern Nova uploads only | RUNS / RUNS | bytes as imported |
| media path `jr://file/…` | **HELD-NEW**: a held path per media reference: an imported reference keeps HQ's path, and a Nova-born reference takes the path derived from its asset's bytes when it is made, a logo the uploader's slot path (Nova derives every path today and stores none, `assetWirePath.ts`) | n/a | the held path |
| `multimedia_map` key not under `jr://file/` that the build keeps | **REFUSED**: not HQ-buildable: `MediaResourceError` (`MediaSuiteGenerator.media_resources`, over `multimedia_map_for_build(remove_unused=True)`) | — | — |
| a media reference with no `multimedia_map` entry (no file uploaded for it) | **HELD-NEW**: a media reference holding its path with no file: Vellum writes a default `jr://file/commcare/…` path as soon as a media slot is added, before any upload (`javaRosa/itextWidget.js::getDefaultValue`), HQ builds it with no resource for it (`MediaSuiteGenerator.media_resources` reads only map entries), and Android shows its missing-media placeholder (`MediaLayout.showMissingMediaView`) | DIFFERENT (no image) / RUNS (placeholder) | the held path; no bytes |
| print template (`jr://file/commcare/text/<id>`, HTML) | **REFUSED**: retiring (VELLUM_PRINTING; only a print callout reads it) | — | — |
| per-language media on labels, menus and options | → Itext, markdown and label text / Module fields (`localizedMedia`) | — | — |
| media referenced only through `big-image` or custom itext forms | → Itext, markdown and label text (`big-image` refused; custom form names inert) | — | — |
| `multimedia_map` | → Application | — | — |
| `media_suite.xml` resource shape | **HELD**: derived: relative local location (`./…`) per resource | RUNS / RUNS | local `./` locations (HQ adds remote fallbacks) |

## Lookup tables (Project data an app references)

Each gap in Nova's lookup model is HELD-NEW here so an HQ app's tables import exactly.

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| table `tag` in Nova's grammar | **HELD**: `LookupTable.tag` | RUNS / RUNS | workbook `table_id` |
| `tag` or field name with `-`, `.`, non-ASCII letters, or starting `xml` in any case other than all lowercase, or equal to a Nova-reserved instance name other than `casedb`/`ledgerdb` | **HELD**: widen: HQ's grammar, an XML name without a colon that does not start with lowercase `xml` (`fixtures/utils.py::is_identifier_invalid`, which asks lxml whether `Element(name)` is valid), any name HQ accepts, held verbatim; the row below refuses one Core's XPath cannot read where an expression reads it | RUNS / RUNS | verbatim in the workbook; in the XForm the instance id is made unique (`commcaresession-1`) where it would equal an instance the form declares, as Vellum does (`form.js::addInstanceIfNotExists`) |
| `tag` or field name Core's XPath lexer does not read as a name (any character other than Core's name characters, README "External identity": a letter without case such as `नाम` or `名前`, a titlecase letter such as `ǅ`, most combining marks, `·`, `‿`, `€`, a character outside the Basic Multilingual Plane) that an expression reads | **REFUSED**: broken at runtime: Core reads a name one UTF-16 unit at a time, only upper- or lowercase letters or `_` first, then those, decimal digits, `.` and `-` (`Lexer.matchNCName`), so an expression reading through that name does not parse, and a form holding one does not load (executed) | — | — |
| `tag` `types` | **HELD-NEW**: a table that can be referenced but not adopted: a workbook's `types` sheet holds every table's definition (`fixtures/upload/workbook.py`), so no push can carry it (Nova refuses it today, `lib/export/boundaryValidation.ts::lookupHqReservedTagFindings`), though HQ's table editor accepts the tag | RUNS / RUNS | none (referenced) |
| `tag` containing `casedb` or `ledgerdb` | **REFUSED**: broken at runtime: `generateRoot` matches the substring first and serves the case or ledger database | — | — (Nova's own tag schema must refuse it too) |
| `fields[].properties` and multi-valued cells (`<name lang="en">…</name><name lang="hin">…</name>`) | **HELD-NEW**: `LookupColumn.properties` + multi-valued cells | RUNS / RUNS | workbook types-sheet `field N : property M` columns, and item-sheet `field: <name> <n>` and `<name>: <property> <n>` columns |
| `item_attributes` and per-row attribute values | **HELD-NEW**: `LookupTable.rowAttributes` | RUNS / RUNS | workbook types-sheet `property M` and item-sheet `property: <attribute>` columns |
| `is_global: false` + row owners (user / group / location) | **HELD-NEW**: `LookupTable.ownership`; the owners themselves are the project space's users, groups and locations | RUNS / RUNS | workbook owner columns |
| `fields[].is_indexed` | **HELD-NEW**: `LookupColumn.indexed` | RUNS / RUNS | `field N: is_indexed?` |
| `description` | **INERT**: HQ interface metadata no device reads (`fixturegenerators.py::to_xml`); the workbook has no column for it and no API sets it after create | n/a | cleared by the first workbook push, as HQ's own bulk upload does; adoption says so |
| cell values (always strings in HQ) | **HELD**: `text` columns (byte-exact; numeric columns would reformat `007`, `1.50`) | RUNS / RUNS | verbatim strings |
| absent field vs zero values vs empty string | **HELD-NEW**: the two cell states a device tells apart: no element (zero values) and an empty element (an empty string, or a field absent from the row, which HQ writes the same way, `fixturegenerators.py::to_xml`) | RUNS / RUNS | per state |
| row order (`sort_key`) | **HELD**: fractional row order | RUNS / RUNS | row order |
| table or row count beyond Nova's caps (5,000 rows, 250 columns, 64 KiB cell, 256 KiB row, 8 MiB table) | **HELD-NEW**: import-sized tables. HQ caps one workbook upload at 500,000 rows over all its sheets, the types sheet and header rows included (`fixtures/upload/const.py::MAX_FIXTURE_ROWS`, `WorkbookJSONReader`); Nova splits a push into workbooks under that cap (today it refuses an over-cap workbook, `lib/export/boundaryValidation.ts`), which HQ allows because a workbook leaves tables it does not name alone (`run_upload.py` processes tables with `delete_missing=False`), and a table too large for one workbook can be referenced but not adopted | RUNS / RUNS | as imported |
| HQ table and row ids (uuid4: a workbook upload re-mints a table, with all its rows, when its fields, attributes, globality or description change, and otherwise each changed row) | **TARGET-OWNED**: target records; the deployment ledger maps them | n/a | omit |
| `is_synced`, `last_modified` | **TARGET-OWNED**: target-side state | n/a | omit |
| `FixtureSelect.localize` (display column as an app-string key) | → Module fields `fixture_select` (refused) | — | — |
