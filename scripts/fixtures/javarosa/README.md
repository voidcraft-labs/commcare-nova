# Native CommCare Core proofs

These fixtures consume current Nova exports through native Core parsers,
form entry, evaluation, navigation and case processing. Each family below states
its actual consumer and limits. The frozen source used for the audit is CommCare Core
`8e9ba8d908e95f4dc71c9ade0467c6ebfbfbd305`.

First generate current XPath resources from the Nova checkout:

```bash
mise exec -- npx tsx scripts/fixtures/hq/emit-xpath-evidence.ts /tmp/nova-xpath-evidence
```

From a detached checkout of that SHA:

```bash
mise exec java@17 gradle@8.1.1 -- gradle \
  -I /path/to/commcare-nova/scripts/fixtures/javarosa/compatibility-proof.init.gradle \
  -PnovaProofDir=/path/to/commcare-nova/scripts/fixtures/javarosa \
  -PnovaProofResources=/tmp/nova-xpath-evidence \
  test --tests nova.compatibility.XPathCarrierCompatibilityTest \
  --no-daemon --max-workers=2 -Dorg.gradle.jvmargs=-Xmx768m
```

The init script adds these proof sources and resources to Core's test source set;
it does not modify the Core checkout.

## Case capture execution

First run the producer and native HQ proof in [../hq/README.md](../hq/README.md).
They produce actual local and HQ-regenerated forms for five accepted documents.
Then run from the same detached Core checkout:

```bash
mise exec java@17 gradle@8.1.1 -- gradle \
  -I /path/to/commcare-nova/scripts/fixtures/javarosa/compatibility-proof.init.gradle \
  -PnovaProofDir=/path/to/commcare-nova/scripts/fixtures/javarosa \
  -PnovaProofResources=/tmp/nova-case-evidence \
  test --tests nova.compatibility.CaseCaptureRuntimeTest \
  --no-daemon --max-workers=2 \
  -Dorg.gradle.jvmargs='-Xmx768m -XX:MaxMetaspaceSize=384m'
```

Ten tests run real `FormParseInit`, `FormDef.initialize`, native form-entry
traversal, answer propagation, XPath evaluation and `XFormSerializingVisitor`.
Only the session and existing case data are supplied. User repeats are created
through the entry controller; fixed query repeats materialize through native
entry events. The checks verify distinct attachment filenames and submission
URLs, hidden questions omitting both case writes, active blank URLs clearing
one property, untouched neighboring rows retaining their URL, capture fields
starting empty on followup, and child indices naming the selected parent. The fifth document updates two
selected cases: shared filenames reach both IDs, hidden captures omit both
writes, blank shared values preserve both records, and all-blank shared answers
omit the entire ordinary update transaction.

This does not upload attachment bytes, submit to HQ or apply a server case
transaction. Gradle XML reports live under `build/reports/tests/` in the Core
checkout. The ordinary Nova tests check the same accepted fixtures and compiled
artifacts without requiring a developer's native checkout.

## Typed arithmetic

`emit-arithmetic-evidence.ts /tmp/nova-arithmetic-evidence` produces the fully
admitted `arithmeticFixture` through the production CCZ compiler. Run it with
`node --conditions=react-server --import tsx` from the Nova checkout, then use
the Gradle command above with `-PnovaProofResources=/tmp/nova-arithmetic-evidence`
and `--tests nova.compatibility.ArithmeticRuntimeTest`.

Four sign combinations initialize the actual form, set integer and decimal
answers, submit through `XmlFormRecordProcessor`, and inspect stored cases.
They verify integer quotients, signed remainders, a decimal answer containing
`10`, and a literal beyond int4. The same document runs through the real
Preview submission builder and PostgreSQL store. Separate native scalar probes
retain Infinity/NaN on zero division; they do not prove non-finite case writes.
Replacing only the exported integer quotient with raw division fails all four
stored-value assertions. This proof covers the local CCZ form; it does not run
HQ's import or server case processor, and it does not claim identical numeric
precision across evaluators. See `native-core-arithmetic.json` for provenance.

## Case-operation execution

The same producer also emits 12 accepted operation documents. Run
`nova.compatibility.CaseOperationRuntimeTest` with the command above, or add a
second `--tests` selector to run it with the capture proof. Its 24 cases open
both the CCZ and HQ-regenerated forms. It supplies session data and seeded native
`Case` records through Core's indexed in-memory storage, uses the native
`CaseInstanceTreeElement` for XPath reads, finalizes the form with
`postProcessInstance`, and sends the serialized form to
`XmlFormRecordProcessor` and `CaseXmlParser`.

Assertions inspect the stored cases: generated and authored IDs, conditional
create/retype dependencies, original snapshot reads, final writes and closure,
link creation/removal, scalar normalization and bounds, nested-menu child
selection, and repeat-local relation conditions. A two-row query deliberately
reuses an authored key and confirms the accepted same-type merge. Invalid keys,
names, owners, external IDs and dynamic link targets must raise native
`InvalidStructureException`. The accepted counterpart executes in the same
harness. A negative control replacing the dynamic-link guard with the selected
case ID fails because a missing target becomes an accepted unlink.

This proof does not establish rollback: Core's in-memory test storage applies
records as the parser visits them. It also does not run Android or HQ's server
case processor.

## XML text execution

Run the XML producer and HQ proof above, then select
`nova.compatibility.XmlTextRuntimeTest` with
`-PnovaProofResources=/tmp/nova-xml-evidence`. Two cases initialize the actual
CCZ and HQ-regenerated forms, assert the tab/LF/CR-bearing default answer and
read the worker's question prompt with accents, combining marks, non-Latin
scripts, emoji and C1 characters. This checks runtime values, not only parsing.

## Case-tile suite parsing

Run the tile producer and native HQ proof in [../hq/README.md](../hq/README.md),
then use the command above with `-PnovaProofResources=/tmp/nova-tile-evidence`
and `--tests nova.compatibility.TileSuiteRuntimeTest`. Sixteen cases parse the
full local suite or the HQ-regenerated detail artifact through Core's actual
`SuiteParser`, with resource installation disabled via its existing constructor.
They inspect native `Detail`/`DetailField` values, maximum grid dimensions,
hidden sorting, explicit and inherited style, and group header depth. Local
suites also resolve the form/browse entries and inspect entity/computed datums
for persistent details and group companion data. This does not exercise an
Android or Web Apps renderer, nor claim a full HQ-generated navigation suite.

## Navigation, ordinary case writes and Search payloads

Run the navigation producer and HQ form proof in [../hq/README.md](../hq/README.md).
Use `-PnovaProofResources=/tmp/nova-navigation-evidence` with the command above
and select `--tests nova.compatibility.NavigationRuntimeTest`.

Six methods cover saved-value/default precedence (including stored blank) and
normalized registration external IDs on both form paths; actual suite instances
for module and case conditions; native case nodes for empty/whitespace owner
exclusions; link/fallback frame selection; and actual `RemoteQueryDatum` payloads
for supplied and absent prompts. The native processor writes into Core's
in-memory storage, which does not prove server database rollback. Navigation
checks evaluate parsed conditions and frame values without an Android session.
The test writes `build/nova-search-payloads.tsv` for the HQ CSQL proof. Its ten
rows must compile to the expected complete date filters; no Elasticsearch
request or rendered Search screen is claimed.

## Search sessions, claiming and form links

Run the Search producer and HQ proof in [../hq/README.md](../hq/README.md), then
select `--tests nova.compatibility.SearchRuntimeTest` with
`-PnovaProofResources=/tmp/nova-search-evidence`. Seven methods consume both
export paths through the real suite parser, without installing resources.
Native entity nodesets exclude related rows and wrong case types, enforce the
inline open-case filter and parent selection, and preserve remote Search's
different status behavior. Actual detail templates read a typed supporting
parent and reject the same ID under another case type. Native case storage and
`PostRequest` evaluate claim parameters and relevance for single, parent and
multiple selections. No claim HTTP request is sent.

`CommCarePlatform` registers the parsed suite and `CommCareSession` selects the
query. The actual `RemoteQuerySessionManager` owns default answers and virtual
input instances, including changed/cleared answers, hidden prompts, translated
query parameters and normalized owner exclusions. Search-input instances start
with allocated native bases and deferred roots; supplying an empty root would
incorrectly prevent the query manager from supplying current answers.

Both native form-link frames hydrate the newly created case from the source
context. The retained pre-fix local and HQ suites are negative controls: Core
rejects their query step because the later manual datum assignment cannot
supply a value to an earlier step. This proves native frame/value execution,
not a complete Android session, HQ build or remote transaction.

## Search prompt state

After the prompt producer and HQ regeneration above, run the same bounded Gradle
command with `-PnovaProofResources=/tmp/nova-prompt-evidence` and
`--tests nova.compatibility.SearchPromptRuntimeTest`.

Four methods exercise both suites through the native query manager. The manager
creates its own input instance, validates answer changes and refreshes itemsets.
The fixture supplies emitted lookup bytes and session data, and registers source
locale strings with the native localizer. Assertions check required conditions,
combined author/CSQL rules, visible/hidden defaults, exact labels and parameters,
unavailable-selection removal, numeric/location guards and quote obligations
shared by two composed answers. The lookup value is checked in the actual CSQL
payload. This does not install resources, render widgets or send a search request.

## Nested CSQL functions

After the function producer and HQ regeneration above, run the bounded command
with `-PnovaProofResources=/tmp/nova-function-evidence` and
`--tests nova.compatibility.CsqlFunctionRuntimeTest`. Two methods use native suite
parsing and the actual query manager on both export paths. Emitted lookup rows
feed date, datetime, numeric and date-arithmetic function arguments; changing
session data changes a conditional nested argument. The methods write
`build/nova-function-payloads.tsv` and `build/nova-function-arguments.tsv` for the
HQ proof. The latter establishes parsed relation structure, not server relation
results. No resource installation, Android renderer or remote request is claimed.

## Runtime quote guards

After the quoting producer and native HQ comparison, run the same Gradle command
with `-PnovaProofResources=/tmp/nova-quote-evidence` and
`--tests nova.compatibility.CsqlQuoteRuntimeTest`. One method drives 12 answer
states on each export path through the actual `RemoteQuerySessionManager`,
including clearing and an explicitly present empty answer. It checks prompt
error ownership and complete refusal values even when prompt validation is
bypassed by asking for raw query parameters. The resulting 144 queries are
written to `build/nova-quote-payloads.jsonl` for the independent HQ compilation
check. No XPath source replacement, Nova evaluator, Android widget or HTTP
request is used as a substitute for native query values.

## Static quote branches

After the static-quote producer and HQ regeneration above, run the same bounded
Gradle command with `-PnovaProofResources=/tmp/nova-static-quote-after` and
`--tests nova.compatibility.StaticQuoteRuntimeTest`. Two methods compare four
retained pre-fix refused queries with four safe queries on each current export
path. The source conditions cover null/empty-text equality and inequality,
ordered switch selection, and numeric equality within Core's tolerance. The
negative suite was exported before the admission fix at Nova `06f097e1`; it
must not be regenerated by bypassing current validation. Native execution uses
the actual suite parser and query manager without resource installation,
Android rendering, HTTP or Elasticsearch execution.

## Property-free relation instances

After the relation-instance producer and HQ regeneration above, run the same
bounded Gradle command with
`-PnovaProofResources=/tmp/nova-relation-instance-evidence` and
`--tests nova.compatibility.RelationInstanceRuntimeTest`. Five methods retain
the missing-instance failure from Nova `bffd10f7` and open/submit four independent
relation consumers. Each current form runs on both export paths with zero and
two matching children, plus unrelated and wrong-type rows. The native form-entry
controller, serializer and case processor determine the final stored value.
The in-memory native case store does not establish server transactions or
rollback; no Android rendering, HQ submission or network request runs.

## Location owners

After the location producer and HQ proof in [../hq/README.md](../hq/README.md),
run the same Gradle command with
`-PnovaProofResources=/tmp/nova-location-evidence` and
`--tests nova.compatibility.LocationOwnerRuntimeTest`.
Five tests parse real HQ indexed restores into Core fixture storage and run local
and HQ-regenerated forms through initialization, form entry, serialization and
case processing. Both branches resolve their exact immediate or multi-level
destination; skipping a non-owning intermediate place remains valid. Ordinary
worker ownership works with empty location data. An empty fixture and a missing
destination are refused through native evaluation or the emitted scalar guard,
with no assertion of rollback in Core's in-memory fixture. Native storage and
form processing run in memory; this does not submit to HQ or establish device
UI behavior.

The Android transaction wrapper was separately source-verified at
`79d8418ab2dcd9846ae297c8f1edd189393b8e35`: synchronous
`FormRecord.updateAndProcessRecord` and background
`FormSubmissionHelper.checkFormRecordStatus` wrap the complete
`FormRecordProcessor.process` call in the same user SQLCipher transaction used
by `AndroidCaseXmlParser`. Both mark it successful only after processing returns
and always end it, so the native invalid-case guard prevents transaction commit.
This source check is distinct from running Android storage or UI tests.


## Additional native consumers

Use the bounded Gradle command above, replacing `-PnovaProofResources` with the
producer's output directory and `--tests` with the class below. Run the matching
producer and any HQ regeneration listed in [../hq/README.md](../hq/README.md)
first. Generated resources are required; the checked-in static files retain only
selected regression counterexamples.

| Family | Native class | What runs |
| --- | --- | --- |
| Connect | `ConnectRuntimeTest` | Actual form initialization, computed metadata, worker/case selection and serialized namespace on CCZ and HQ paths. |
| Oracle controls | `XFormOracleRuntimeTest`, `SuiteOracleRuntimeTest` | Real parser acceptance/refusal for finite corrupted XML corpora, plus native detail text evaluation. These deliberately malformed private fixtures are not admitted apps. |
| Form links | `FormLinkRuntimeTest` | Native ordered stack frames, conditions and selection values from complete local/HQ suites. |
| Media | `MediaRuntimeTest` | Native media manifest installation paths and localized prompt references; no remote download or Android rendering. |
| Lookup data | `LookupRuntimeTest` | Actual fixture storage/install and replacement, current row/filter/label evaluation, dynamic choices, answer serialization and case processing. |
| Groups/repeats | `ContainerRuntimeTest` | Native group relevance, repeat entry, per-row values and serialized case effects for local/HQ forms. |
| Localization | `LocalizationRuntimeTest` | Native locale reader, language switching, prompts, user-facing text and serialized values; no text layout claim. |
| Worker property identities | `WorkerIdentityRuntimeTest` | Real session-data references through form and suite expressions on both paths. |
| Search endpoints | `EndpointRuntimeTest` | Native remote-request URLs and parameters; the HTTP request is not sent. |
| No-match registration | `NoMatchesRuntimeTest` | Native result-count relevance, registration actions and source/target navigation state. |
| Nested menus | `NestedMenuRuntimeTest` | Native selected-case membership, parent/child datum values and smaller child selection maxima. |
| Expander corpus | `ExpanderRuntimeTest` | Full native suite/form parsing of the captured admitted corpus, plus actual double-digit choice-label substitution and evaluation. Form parsing does not initialize every corpus form. |
| Predicate operators | `PredicateRuntimeTest` | Fifty-two schema-parsed private AST programs on native instance trees: positive/negative comparisons, precedence, quotes, presence, same-row relations and GPS guard short-circuiting, including distinct kilometer/mile boundaries. No whole-app admission, HQ build or database semantics are claimed. |

The nested-menu producer intentionally retains two currently refused HQ projections
as counterexamples. Core proves all ten local shapes work. The native HQ path
loses a relation parent selected multiple times and fails to enforce a smaller
child maximum; target admission refuses those two projections. The other eight
HQ shapes retain complete native structural parity. These are wire/runtime
checks, not Android interaction tests.

XPath proofs execute the production lowerer and independently inspect native
built-in dispatch and parser arities. They do not reconstruct a lowerer in Java.
The parser's custom-function fallback is distinguished from actual native
registration, and the raw `normalize-space()` negative remains deliberately
unhandled. The finite corpus includes nonbreaking-space coercion neighbors.

`TileGroupingRuntimeTest` uses `emit-tile-evidence` resources. It completes native
case selection in three grouped form-entry variants and verifies the computed
parent IDs. A retained pre-fix suite must throw for the missing session instance;
the current suites resolve their declared instances. This executes session
selection, independently of tile rendering.
