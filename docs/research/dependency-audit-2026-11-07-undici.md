# Undici 8.12.4 audit for #872

Audited November 7, 2026. [PR #872](https://github.com/voidcraft-labs/commcare-nova/pull/872)
updates the direct Undici dependency from 8.12.3 to 8.12.4. The proposed patch
was rebased onto main `d3e8cd0e`; no application compatibility changes were
needed. This audit covers the published package bytes, Nova's consumers, local
verification, and the limits of the security update.

## Exact scope and installation

- `package.json`: `undici` changes from `^8.12.3` to `^8.12.4`.
- `package-lock.json`: the same root requirement and the root Undici entry's
  version, tarball URL, and integrity change. The only other entry change marks
  `@hono/node-server@2.1.6` as development-only. `npm explain` confirms its sole
  installed path is `agent-react-devtools -> @modelcontextprotocol/sdk`; no
  production consumer or package version is removed by that metadata correction.
- The package files exactly match Dependabot's proposal after the rebase.
  `npm ci` leaves the lockfile unchanged, passes strict install-script policy,
  and completes the pinned profiler hardening and Fumadocs postinstall.
- Node 24.21.0 and npm 12.0.2 are unchanged. Undici's engine requirement remains
  Node `>=22.19.0`; entry points and production dependency/peer requirements do
  not change. No new install script or export migration is introduced.
- [8.12.4 was released November 5](https://github.com/nodejs/undici/releases/tag/v8.12.4).
  This is Dependabot's security update; `.github/dependabot.yml` explicitly
  allows security updates to bypass the routine three-day patch cooldown.
  No override, ignored version, profiler pin, or other resolution was changed.

## What Nova actually executes

`lib/agent/openaiProvider.ts` imports the npm package's `Agent` and `fetch`
together. `createModelCallTransport` binds a private dispatcher with 20-minute
header and body-idle ceilings; caller abort signals provide cancellation.
`createNovaOpenAI` uses this transport for serving model calls through
`agentRunContext`, `generationContext`, and `documentExtraction`. Architect,
peer, ordinary editing, translation, and extraction therefore receive the
updated transport without changing their prompts, tools, model settings, or
stream-completion rules. Evaluation scripts that use this constructor benefit
too. Older standalone scripts using bare `createOpenAI` do not use this wrapper.

The serving transport neither installs a global dispatcher nor composes cache,
redirect, retry, dump, or decompress interceptors. It sends JSON model requests,
does not set fetch `integrity`, and retains the supported `Agent`/`fetch` API.
No active Nova API becomes deprecated in this patch. HTTP/2 is enabled by the
package's default when negotiated, so the HTTP/2 fixes are relevant even though
Nova does not explicitly set `allowH2`.

`__tests__/helpers/httpPeer.ts` uses `MockAgent` and `Agent` to control native
fetch peers, including HQ publishing, lookup data, compatibility, and media.
`proof/corpus/targetPeer.ts` uses an Agent to remap the named target to a local
socket. These global dispatcher changes are test/proof scope, with teardown.
Neither configures `ignoreTrailingSlash`. Testcontainers 12.2.1 also resolves
the root 8.12.4 package for its HTTP wait strategy. The Postgres fixture uses
its own configured readiness strategy; this update does not alter it.

There are separate HTTP implementations this PR does **not** replace:

- Node 24.21.0 reports `process.versions.undici === "7.29.1"`. Native fetch,
  including HQ/auth paths that use it, remains tied to the pinned Node runtime.
  An npm update is not evidence that the Node runtime has received these fixes.
- `@ai-sdk/provider-utils@5.0.71` resolves its own Undici 7.30.1 for its safe
  download fetch. That is separate from Nova's explicit model transport.
- The frozen `@ai-sdk/workflow@1.0.70` has provider-utils 5.0.27 and Undici
  7.29.1 beneath it. Nova imports `WorkflowChatTransport` for browser reconnects;
  that browser path uses platform fetch, not the Node-only safe-download Agent.
  The vulnerable package remains installed and is still reported by npm audit.
- Shadcn, its registry, and dotenvx retain their own 7.30.1 copies. The checked-in
  proof artifact download bundle also does not regenerate from this npm bump.

## Published code review and adoption decisions

Compared both [8.12.3](https://registry.npmjs.org/undici/-/undici-8.12.3.tgz)
and [8.12.4](https://registry.npmjs.org/undici/-/undici-8.12.4.tgz) tarballs,
including every changed implementation file, declarations, entry points, and
package metadata. The diff changes 13 implementation files, three declaration
files, five documentation files, and package.json. The
[upstream comparison](https://github.com/nodejs/undici/compare/v8.12.3...v8.12.4)
and [release](https://github.com/nodejs/undici/releases/tag/v8.12.4) provide context.

| Change | Nova impact and decision |
| --- | --- |
| Cache redirect-chain policy, GHSA-mqg3-3v4r-cm32 | Every hop must satisfy origin/storage policy; freshness is bounded by the strictest hop and Vary fields are combined. SQLite cache version advances 4 to 5 to invalidate unsafe entries. Nova configures no Undici cache; no data migration is needed. |
| Credentialed redirect aliases, GHSA-7xg3-fphp-28hg | Credential-bearing redirected responses cannot populate the original alias cache key. Nova has no shared Undici cache, so this vulnerable composition is absent. |
| Revalidation target/validator checks, GHSA-5rm8-gv32-r954 | A redirected 304 cannot validate another URL's representation; mismatches invalidate and refetch. No Nova cache revalidation path uses this interceptor. |
| Tuple-header credential stripping, GHSA-9v6h-8rgp-m69f | `RedirectHandler` distinguishes tuple arrays from flat arrays when stripping cross-origin credentials. Nova uses fetch's own redirect algorithm, not the affected interceptor composition. No header conversion workaround is needed. |
| Cache replay error routing, GHSA-3g9m-rv3r-w5w2 | Replay callbacks and async-store failures converge on request errors instead of escaping process-level handlers. No matching cache/dump/decompress composition exists in Nova. |
| Integrity whitespace, GHSA-r4pc-4jcp-7pqc | SRI tokens split on all ASCII whitespace. Nova's model fetches set no integrity metadata; the fix is adopted by upgrading, without adding integrity settings to API responses. |
| Request cancellation after garbage collection | Request signals retain their controllers and share source listeners; constructor copies and clones preserve abort propagation after parent Requests are collected. Directly relevant to cancellation reliability of long model calls; existing signal forwarding already adopts the fix. |
| HTTP/2 release and GOAWAY handling | Persistent error sinks prevent late released-stream errors from crashing a process. Live stream IDs protect accepted streams; unsent HEADERS racing GOAWAY may be replayed once on a usable connection, subject to replayability and cancellation checks. Relevant to negotiated model connections; no new application retry layer is needed. |
| Async iterable request bodies | Reading becomes demand-driven, with cancellation forwarded to the reader. Nova's OpenAI requests are JSON strings; no streaming-upload migration is needed. |
| Interim 1xx responses | DecoratorHandler accepts informational responses before the final response. No custom Nova decorator must change. |
| Mock dispatch | Mock controllers expose `aborted`; optional trailing-slash normalization now preserves query strings. Existing peers work unchanged and do not enable that normalization option. |
| SQLite contention and RISC-V | Cache operations skip busy/locked writes; HTTP/1 parsers avoid WASM SIMD on RISC-V. Neither introduces a Nova option or migration. |
| Type and documentation corrections | FormData iterator methods are declared as prototype methods; HttpMethod includes QUERY; retry docs catch up with existing defaults. No runtime retry policy changed, and Nova needs no method or FormData conversion. |

The optional caching/retry APIs do not justify enabling them on authenticated
model calls. Existing supported transport APIs deliver the relevant fixes.
No model-context version, plugin contract, public documentation, or application
schema changes are necessary.

## Verification

On current main plus the exact proposed package patch:

- Strict `npm ci`, `npm run lint`, and `npm run typecheck` pass.
- Ten focused test files pass, 91 tests total: model transport, model-step
  completion, subgeneration, structured document extraction, request wiring and
  caching options, HQ lookup/compatibility peers, deployment observation, and
  provider-import enforcement. Transport tests cover successful request bytes,
  header/body timeouts, and cancellation before headers and during the body;
  SDK tests retain interrupted-stream refusal.
- A temporary local TLS HTTP/2 peer exercised the actual
  `createModelCallTransport`: three successful streams followed by cancellation
  of an open response stream, with `h2` negotiation asserted and sockets closed.
  This checks interoperability and cancellation, not every GOAWAY race.
- Two isolated published-package probes distinguish old and new behavior:
  after forced GC, a retained signal from copied/cloned Requests fails to abort
  under 8.12.3 and aborts under 8.12.4; a tab-delimited SHA-256 integrity mismatch
  is accepted under 8.12.3 and rejected under 8.12.4. These exercise upstream
  defects directly; they are not claims that Nova constructs copied Requests
  or uses SRI in its current model calls.
- The original PR head `cf9c460e1b2d9be43a5b15561b24daff47af9fa1` had 36
  successful CI jobs; the optional audit sample and separate CodeQL check were
  skipped. That evidence predates the rebase. The updated PR must complete CI
  again; exact final-head results are recorded on the PR, not inferred from
  those older checks. The PR proof lane is not the full scheduled served-reader
  run.
- No paid model/schema calls or production writes were used.

## Residual advisories

`npm audit --json` after installation reports 22 package entries: two low,
17 moderate, and three high. The root Undici 8.12.4 entry is not flagged. The
remaining Undici finding is the nested workflow 7.29.1 copy, with earlier
EventSource, SRI, cache, TLS, decompression, and WebSocket advisories. The report
does not inspect Node's bundled implementation and cannot establish its safety.

Other entries trace to glob/minimatch through Sentry, Testcontainers/archiver,
Google SQL dependencies and shadcn/ts-morph; deepmerge through shadcn; and the
audited profiler's pinned nested Zod. No blanket audit fix, parent downgrade,
profiler change, Node upgrade, or cross-major Undici override was applied.
These are residual paths, not evidence that this narrow patch clears the whole
dependency tree. #872 is the only open Dependabot PR at audit time; #734 is a
separate GitHub Actions proof-pin proposal and remains outside this task.
