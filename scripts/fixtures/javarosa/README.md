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
