# JavaRosa XPath compatibility proof

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
