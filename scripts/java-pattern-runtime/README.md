# OpenJDK 17 browser compatibility runtime

This directory reproducibly compiles the regex implementation used by
Formplayer and the portable fdlibm power implementation satisfying JavaRosa's
`Math.pow` contract into static ES modules. The source is OpenJDK 17
`Pattern`, `Matcher`, `FdLibm.Pow`, and their required support from tag
`jdk-17.0.20+8`, peeled commit
`8cbbca61432426a3441aa08838d930ef954ea1ba`. TeaVM 0.15.0 performs the Java to
JavaScript compilation. The result is JavaScript, not WebAssembly.

Two runtime entries expose the operations CommCare Core invokes:
`Pattern.compile(pattern).matcher(input).find()` and `replaceAll` after
`Matcher.quoteReplacement`, plus the OpenJDK 17 fdlibm implementation behind
JavaRosa's `Math.pow`. User-authored patterns execute inside Nova's bounded
XPath worker. Nova's finite machine-generated Pattern sources use a closed,
parity-tested synchronous implementation so the Builder's main thread never
loads the complete Pattern runtime.

Run `scripts/java-pattern-runtime/build.sh` from anywhere in the checkout. The
script pins both its Gradle/TeaVM build image and the exact linux/amd64 Temurin
17.0.20+8 image used to generate character names by OCI digest. It regenerates
all committed artifacts on every run. The verifier rejects dynamic-code CSP
primitives, enforces reviewed size budgets, and pins every generated artifact
by SHA-256. A source or toolchain change therefore requires an explicit
generated-artifact review.

Each production image publishes the complete corresponding-source archive at
`/third-party/java-pattern-runtime-source.tar.gz`. The archive preserves its
repo-root-relative paths and includes these sources, `build.sh`, `verify.mjs`,
and the reviewed generated artifacts. Extract it at the root of a Nova
checkout, then run the build entrypoint above.

The archive also carries `lib/preview/xpath/openJdk17DoubleString.ts`, Nova's
BigInt-backed port of OpenJDK 17 `FloatingDecimal` output semantics. JavaRosa
uses that spelling whenever XPath converts a number to text; JavaScript's
native shortest-decimal spelling differs for a small but observable set of
doubles.

## Pinned Unicode behavior

`OpenJdkCharacterData.java` carries the JDK 17 character categories,
properties, case mappings, scripts, blocks, and exact accepted aliases.
`EmojiData.java` is generated from the same OpenJDK tag's Unicode 13 emoji
data. The generator used for the character tables is retained in `generators/`.

TeaVM does not expose `Character.codePointOf`, so `\N{name}` uses the companion
`javaPatternNames.generated.ts` table. Preview loads that table only when a
pattern contains the construct, resolves the JDK 17 name, and lowers it to the
equivalent Java `\x{codePoint}` syntax before calling `Pattern`.

OpenJDK's external `CANON_EQ` compile flag depends on `java.text.Normalizer`,
which TeaVM does not implement. CommCare Core calls `Pattern.compile(pattern)`
without external flags, so only that preprocessing path is unreachable and
intentionally omitted. Java's embedded `(?c)` flag is reachable; its scoped
`NFCCharProperty` matching uses `BrowserNormalizer` to call the browser's
standards-defined NFC implementation. Unicode normalization stability keeps
the canonical composition behavior stable while the JDK 17 property tables
continue to own regex character membership.

## Provenance and licenses

The OpenJDK-derived sources retain their GPLv2 with Classpath Exception
headers; the complete terms are in `LICENSE-OPENJDK`. `MODIFICATIONS.md`
records Nova's portability changes. TeaVM and its class-library support remain
under the Apache-2.0 `LICENSE` and `NOTICE` included here.
