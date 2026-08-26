# Generated OpenJDK 17 compatibility runtime

`javaPatternRuntime.generated.js` is reproducible TeaVM 0.15.0 output from the
pinned OpenJDK 17 sources under `scripts/java-pattern-runtime/`. It is a static
JavaScript module, not WebAssembly. Do not edit it directly or replace it with
JavaScript `RegExp` or host-dependent `Math.pow`.

`javaPatternNames.generated.ts` is the pinned JDK 17 character-name table used
only for `\N{name}`. It is dynamically imported so ordinary Preview regexes do
not download or decode it.

Regenerate the runtime and verify both reviewed artifacts with
`scripts/java-pattern-runtime/build.sh`. Source provenance, modifications,
license terms, and the verifier live beside that build definition. Production
publishes the complete package at
`/third-party/java-pattern-runtime-source.tar.gz`.
