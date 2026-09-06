# Native CommCare Core proofs

This fixture runs Nova's production `normalize-space()` lowering through the
real CommCare Core evaluator and through XForm parsing and initialization. The
frozen source used for the audit is CommCare Core
`8e9ba8d908e95f4dc71c9ade0467c6ebfbfbd305`.

From a detached checkout of that SHA:

```bash
mise exec java@17 gradle@8.1.1 -- gradle \
  -I /path/to/commcare-nova/scripts/fixtures/javarosa/compatibility-proof.init.gradle \
  -PnovaProofDir=/path/to/commcare-nova/scripts/fixtures/javarosa \
  test --tests nova.compatibility.XPathCarrierCompatibilityTest --no-daemon
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
case processor. `docs/research/test-suite-audit/native-core-operations.json`
records the passing methods, native sources and exact exported form hashes.

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
