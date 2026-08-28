# Generated OpenJDK 17 compatibility runtime

`javaPatternRuntime.generated.js` and `javaMathRuntime.generated.js` are
reproducible TeaVM 0.15.0 outputs from the pinned OpenJDK 17 sources under
`scripts/java-pattern-runtime/`. They are static JavaScript modules, not
WebAssembly. The separate entries keep arbitrary Pattern support worker-only
while synchronous XPath imports only the small fdlibm `pow` implementation.
Do not edit them directly or replace user-authored Pattern execution with
JavaScript `RegExp`, or fdlibm with host-dependent `Math.pow`.

`javaPatternNames.generated.ts` is the pinned JDK 17 character-name table used
only for `\N{name}`. It is dynamically imported so ordinary Preview regexes do
not download or decode it.

Regenerate the runtime and verify both reviewed artifacts with
`scripts/java-pattern-runtime/build.sh`. Source provenance, modifications,
license terms, and the verifier live beside that build definition. Production
publishes the complete package at
`/third-party/java-pattern-runtime-source.tar.gz`.
