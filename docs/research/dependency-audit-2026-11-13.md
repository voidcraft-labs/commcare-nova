# Dependency audit, 2026-11-13

## Scope and provenance

Consolidates the two open Dependabot security updates on main
`3482b24fd93ab8e6f2bf69829c6a3b572a9ce16b`:

| Original PR | Audited head | Change |
| --- | --- | --- |
| [#907](https://github.com/voidcraft-labs/commcare-nova/pull/907) | `922d1d87061b3759f7eb58a29ad95dae621ddb1d` | fast-xml-parser and its required resolutions |
| [#908](https://github.com/voidcraft-labs/commcare-nova/pull/908) | `a6c07a3c9ea0792db282b6fff5008a9944a711d9` | Hono |

Both original CI runs passed. The replacement still needs its own complete CI
gate. The github-actions-authored upstream proof-pin PR #734 is separate.

The lockfile is exactly the union of the two bot patches relative to their base,
applied to current main. A structural comparison of every package entry after
`npm ci` confirmed no additional resolution or package-set changes:

| Package | Before | After |
| --- | --- | --- |
| fast-xml-parser | 5.11.1 | 5.12.1 |
| fast-xml-builder | 1.3.1 | 1.3.2 |
| @nodable/entities | 3.0.0 | 3.1.0 |
| is-unsafe | 2.0.2 | 2.0.3 |
| strnum | 2.4.2 | 2.5.1 |
| hono | 4.13.13 | 4.13.18 |

These are the proposed security-update resolutions. The parser release and its
builder resolution are dated November 13; Hono 4.13.18 is dated November 11.
Security updates bypass the configured five-day minor and three-day patch
cooldowns. No routine update, override, ignore, direct dependency, profiler pin,
runtime pin, or install-script policy changes. Node 24.21.0 and npm 12.0.2 were
used through mise. The strict install and profiler byte-hardening both passed.

## XML family

Sources: [parser releases and source diff](https://github.com/NaturalIntelligence/fast-xml-parser/compare/v5.11.1...v5.12.1),
[5.12.1 release](https://github.com/NaturalIntelligence/fast-xml-parser/releases/tag/v5.12.1),
[stop-node advisory](https://github.com/advisories/GHSA-474x-hrwr-fgx4),
and the old/new installed npm artifacts (`src`, declarations, CommonJS exports,
package metadata and shipped changelogs).

`npm explain fast-xml-parser` identifies one consumer:
`@google-cloud/storage@8.4.0`. Its `XMLMultiPartUploadHelper` in
`build/{esm,cjs}/src/transfer-manager.js` creates a default `XMLParser` for
`InitiateMultipartUploadResult.UploadId`, and an `XMLBuilder` with
`arrayNodeName: 'Part'` for completion bodies. Nova's `lib/storage/media.ts`
uses Storage/Bucket/File APIs, signed URLs and bounded streams; it does not
instantiate TransferManager or this XML multipart helper. Nova's CommCare XML
boundary uses its own wire serializer and saxes, not fast-xml-parser.

The parser changes remove repeated scanning of malformed stop-node content,
skip quoted attribute values efficiently, preserve metadata offsets for CRLF
input, and decode non-Buffer Uint8Array input as UTF-8. Declaration corrections
align `setXmlVersion` with its numeric input and add the CommonJS metadata end
offset. The GCS helper accepts strings and Buffers and uses neither stop nodes
nor metadata capture. Its supported parser/builder calls remain valid.

The required sibling changes were audited separately:

- `fast-xml-builder` enforces nesting limits inside stop nodes, validates
  processing-instruction names through the configured sanitizer, and validates
  sanitizer output. The unused `prettifyJs2Xml.js` file disappears; public exports
  are unchanged. GCS's fixed Part/PartNumber/ETag names and default builder
  options require no adaptation.
- `@nodable/entities` has unchanged runtime bytes. Its declaration now correctly
  exposes the named `EntityDecoder` class and numeric `setXmlVersion` method.
  Nova does not import this package; its separate direct `entities` package is
  unchanged.
- `is-unsafe` adds an entity-decoded comparison for HTML/XML/SVG contexts. The
  parser uses it when deciding whether to accept external entity values. This
  tightens that check without a new Nova API or changed GCS helper option.
- `strnum` preserves nonnumeric strings and corrects whitespace/leading-zero
  exponent conversion. GCS's opaque upload identifier remains a string in the
  representative string/Buffer checks.

Package exports, engines and peer requirements are unchanged across these
versions. The parser's dependency floors explain all four sibling resolutions.
Adopt the fixes through the existing supported consumer. No deprecated Nova
call, new product surface, prompt/schema change, or plugin revision is needed.

## Hono

Sources: [complete source diff](https://github.com/honojs/hono/compare/v4.13.13...v4.13.18),
releases [4.13.14](https://github.com/honojs/hono/releases/tag/v4.13.14),
[4.13.15](https://github.com/honojs/hono/releases/tag/v4.13.15),
[4.13.16](https://github.com/honojs/hono/releases/tag/v4.13.16),
[4.13.17](https://github.com/honojs/hono/releases/tag/v4.13.17),
[4.13.18](https://github.com/honojs/hono/releases/tag/v4.13.18),
and the installed old/new `dist` code and package declarations.

`npm explain hono` identifies the development-only chain
`agent-react-devtools@0.4.0 -> @modelcontextprotocol/sdk@1.32.1 -> hono`,
plus the SDK's `@hono/node-server@2.1.6` peer. The old MCP SDK's Node HTTP
transport imports the node-server adapter. Nova serves MCP through the separate
`@modelcontextprotocol/server@2.4.0` package. There are no direct Hono imports in
Nova; the profiler's published daemon uses Node net and ws rather than Hono.

The update repairs path rewriting at mounts, wildcard middleware matching,
form/JSON media-type recognition, CSS escaping and CSRF checks for text/ping.
The latest patch completes media-type validation, bounds body-limit buffering
by bytes rather than retaining each transfer chunk, corrects custom-getPath
mount handling, and refuses ambiguous static-file decoding. Other changes cover
cookie prefix case, query lookup, response cancellation, JWT validation, static
file methods/content negotiation, JSX escaping/nonces, and type accuracy.

Potential adoption points were checked: stricter mount path rejection,
PreparedRegExpRouter regeneration, `strict: false` with custom getPath, and the
new bearer-auth Response callback have no Nova consumer. No Hono routing table,
middleware, JSX or auth integration needs migration. Its public export map,
Node engine requirement and dependency/peer metadata are unchanged. Retain the
audited profiler versions and hardening; the transitive patch does not change
their hashed package bytes.

## Verification

- `npm ci` passed with strict allow-scripts and the existing remote policy.
- `npm run lint` and `npm run typecheck` passed. Biome reported one pre-existing
  informational template-literal suggestion in the office regression fixture;
  no errors or warnings.
- `npm test -- --project unit lib/storage config/reactProfiler.test.ts
  e2e/lib/reactProfileSeed.test.ts`: 6 files and 58 tests passed.
- An uncommitted Node assertion probe loaded the real Storage export and both
  old/new CommonJS XML packages. String and Buffer initiation responses with
  CRLF, UTF-8 and an escaped ampersand produced the expected upload identifier
  and values. Both builders emitted the same independently specified two-part
  completion XML, including quoted/escaped ETags. No cloud request was made.
- The replacement PR's full CI owns database, production-image SDK import,
  auth, browser, CodeQL and proof evidence. The PR proof lane excludes scheduled
  served-reader coverage, and the optional audit-sample job is not requested.

## Residual advisory paths

Read-only `npm audit` decreased from 24 to 22 affected package entries:
2 low, 17 moderate, 3 high. No parser or Hono finding remains in that snapshot.
Counts include dependent-package propagation, not 22 distinct vulnerabilities.

| Remaining source | Installed path and decision |
| --- | --- |
| [Undici advisories](https://github.com/advisories/GHSA-2m5v-pch6-74hx) | `@ai-sdk/workflow@1.0.70 -> @ai-sdk/provider-utils@5.0.27 -> undici@7.29.1`. The root 8.12.4 and other 7.30.1/7.30.2 copies are separate. Keep the frozen workflow policy and this unproposed resolution outside this patch. |
| [Zod constrained collections](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | `agent-react-devtools@0.4.0 -> zod@3.25.76`; root Zod is 4.6.7. Changing the audited profiler or forcing a Zod major is outside scope. |
| [Glob cancellation](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) and [minimatch amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249) | Sentry bundler plugins use glob 13.0.6/minimatch 10.2.6; Testcontainers' archiver and Cloud SQL's rimraf paths retain glob 10.5.0/minimatch 9.0.9. shadcn's ts-morph path also reaches minimatch 10.2.6. No parent upgrades or broad overrides are included. |
| [deepmerge prototype poisoning](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) | shadcn and its registry use deepmerge 4.3.1. The suggested major downgrade is not an appropriate automatic fix. |

These residuals remain visible for separate package-aware work. No blanket
audit fix, paid model probe, production mutation, or merge was performed.
