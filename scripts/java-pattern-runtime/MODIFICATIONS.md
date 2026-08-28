# Nova modifications to the OpenJDK sources

The vendored files originate from OpenJDK tag `jdk-17.0.20+8`, peeled commit
`8cbbca61432426a3441aa08838d930ef954ea1ba`.

Nova makes these bounded portability changes:

- Renames `java.util.regex` to `org.commcare.nova.xpath.openjdkregex`, because
  application code cannot define classes in `java.*`.
- Routes character properties through generated JDK 17 tables instead of
  TeaVM's newer class-library Unicode data.
- Replaces the internal `jdk.internal.util.ArraysSupport.newLength` call with
  the equivalent local growth calculation.
- Resolves `Character.codePointOf` names in the TypeScript worker boundary and
  lowers them to Java's equivalent `\x{codePoint}` syntax.
- Omits the unreachable external-flag `CANON_EQ` preprocessing helpers because
  CommCare Core supplies no compile flags. Java's embedded `(?c)` flag remains
  supported: `NFCCharProperty` routes its scoped input normalization through
  `BrowserNormalizer` and the browser's standards-defined NFC implementation.
- Adds a dated modification notice to every changed OpenJDK-derived source
  file, with this document retaining the complete change inventory.
- Ports the binary-to-decimal half of OpenJDK 17 `FloatingDecimal` to
  `lib/preview/xpath/openJdk17DoubleString.ts`, replacing its private
  `FDBigInteger` storage with exact JavaScript BigInt arithmetic while retaining
  the JDK 17 digit-generation, stopping, rounding, and formatting rules.
- Extracts `FdLibm.Pow` and its double-bit helpers into
  `openjdkmath/FdLibmPow.java`, retaining the OpenJDK 17 computation while
  exposing it through a separate small TeaVM entry point from the regex
  operations. This avoids both TeaVM's ordinary lowering of `Math.pow` to
  architecture-dependent JavaScript `Math.pow` and loading the complete
  Pattern engine for ordinary synchronous XPath arithmetic.

The fdlibm computation and the Pattern parser, matcher graph, backtracking behavior, flags, groups,
replacement behavior, grapheme rules, and the operations exposed to Nova are
otherwise the OpenJDK 17 implementation.
