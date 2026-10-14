# Dependency refresh, October 14, 2026

This replaces Dependabot #725, #726, #735, #736 and #737 against main
`4436ba2e`. The upstream proof-pins PR #734 is a separate source update.
The selected versions come from the five PRs, with two necessary alignments:
Fumadocs core/UI 16.17.1 and MCP client 2.3.1.

## Publication age and installation

Registry `time[version]` was checked for all **154 changed or added lockfile
resolutions** against October 14 at 16:00 UTC. Every patch clears three full
days; every minor/major and newly resolved package clears five. This includes
transitives, not just package.json. The earliest audit cutoff is intentionally
slightly before the actual check. No selected resolution violates the cooldown.
The profiling packages and ignored Workflow 2.x remain outside the update set.

| Direct package | Before | Selected | Publication UTC |
| --- | --- | --- | --- |
| @ai-sdk/openai | 4.0.83 | 4.0.91 | Oct 8 21:40 |
| @ai-sdk/react | 4.0.130 | 4.0.140 | Oct 9 14:58 |
| ai | 7.0.127 | 7.0.137 | Oct 9 14:54 |
| @codemirror/language | 6.12.4 | 6.13.1 | Oct 7 13:20 |
| @google-cloud/storage | 8.2.0 | 8.3.0 | Oct 7 18:44 |
| @lezer/lr | 1.4.10 | 1.4.11 | Oct 7 11:40 |
| @modelcontextprotocol/server | 2.2.0 | 2.3.1 | Oct 5 11:52 |
| @modelcontextprotocol/client | 2.2.0 | 2.3.1 | Oct 5 11:50 |
| @radix-ui/react-dropdown-menu | 2.1.24 | 2.1.25 | Oct 5 23:08 |
| @radix-ui/react-popover | 1.1.23 | 1.2.0 | Oct 5 23:08 |
| @sentry/nextjs | 11.1.0 | 11.5.0 | Oct 7 10:10 |
| @tanstack/react-table | 9.2.4 | 9.2.8 | Oct 8 21:40 |
| @tanstack/react-virtual | 3.14.13 | 3.14.14 | Oct 9 14:59 |
| @types/google.maps | 3.66.5 | 3.66.6 | Oct 9 23:05 |
| fumadocs-core | 16.15.18 | 16.17.1 | Oct 9 13:44 |
| fumadocs-ui | 16.15.18 | 16.17.1 | Oct 9 13:49 |
| fumadocs-mdx | 15.4.6 | 15.4.7 | Oct 9 10:12 |
| motion | 13.4.6 | 14.0.0 | Oct 2 13:15 |
| music-metadata | 11.16.1 | 12.0.0 | Oct 3 13:42 |
| shadcn | 4.21.1 | 4.21.4 | Oct 7 11:12 |
| @iconify-icons/tabler | 2.0.3 | 2.0.4 | Oct 7 20:22 |
| @types/node | 24.19.1 | 24.19.2 | Oct 9 18:44 |
| happy-dom | 20.14.5 | 20.14.6 | Oct 8 23:18 |

The independent transitive PRs select `@modelcontextprotocol/sdk` 1.32.1 and
`shell-quote` 1.12.0. The lockfile retains these versions after consolidation.
All changed resolutions with install scripts were inspected: none introduces
one. Nova's strict script policy is retained. Node 24.21.0/npm 12.0.2 are unchanged.
`npm ls --all --omit=optional` reports a valid peer tree.

## Decisions at Nova's consumers

### AI core, OpenAI, React and transitives

Read the complete published `ai/CHANGELOG.md` and `@ai-sdk/openai/CHANGELOG.md`,
not just Dependabot's truncated excerpts, plus the corresponding installed
source and bundled docs. Upstream sources:
[core](https://github.com/vercel/ai/blob/ai%407.0.137/packages/ai/CHANGELOG.md),
[OpenAI](https://github.com/vercel/ai/blob/%40ai-sdk%2Fopenai%404.0.91/packages/openai/CHANGELOG.md).

The important fixes are abort/cancel completion, fresh model-output timeout
budgets, stopping model-output timers while local tools execute, resumed-stream
message identity, preservation of provider-executed calls, tool-error envelopes,
and asynchronous auto-continuation failures. Nova uses these paths in
`lib/chat/novaChatTransport.ts`, `components/chat/ChatContainer.tsx`,
`app/api/chat/route.ts`, and the build/edit agents. Its provider-wire tests use
the real SDK against a private HTTP peer, with no paid provider call.

The new `onUIMessageStepEnd` agent helper forwards to the existing
`createUIMessageStream.onStepEnd`. Nova already folds all build/edit producers
through that callback, flushes the durable chunk log before saving a snapshot,
and drains the agent independently of the browser. Switching to the new outer
helper would lose Nova's shared fold and lifetime ownership without adding a
new persistence guarantee. Keep the existing supported callback.

The new WebSocket transport requires the SDK's WebSocket protocol and a
persistent server peer. Nova's Postgres-backed reconnect endpoint speaks HTTP
UI-message SSE with persisted cursors; a transport-only swap would break that
contract. Retain the supported Workflow transport and its root-ai override.
The deprecated experimental evaluation API was renamed to `decide`; Nova does
not call either. Decisions and embeddings do not replace Nova's app-authoring
or structured extraction calls. The new portable `max` reasoning option does
not require changing Nova's explicitly selected medium efforts.

Preserve `store: false`, explicit `strict: false` on function tools, optional
argument semantics and Nova's structured-output projection. Updated provider,
provider-utils and gateway packages provide the corrected wire/conversion
behavior automatically. Nova has no gateway or AI-SDK MCP client consumer;
those remain SDK-owned transitives.

### MCP

Read the [2.3 release notes](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol%2Fserver%402.3.0)
and installed declarations/source. The server and stateless transport now own
one connection/request. Nova already creates both through a request-local
`createMcpHandler` factory, so caller identity remains request-scoped. Repeated
HTTP dispatch and existing actual-SDK tests exercise this owning boundary.

Align client/core with server 2.3.1 so the linked SDK tests use one protocol
release rather than keeping a second 2.2 core tree. The new `expectedResource`
option applies to SDK bearer-verifier middleware. Nova instead uses Better
Auth's verifier with explicit issuer and audience, followed by consent/account
revocation checks; replacing it would remove those checks. The new optional
`maxToolInputElements` counts array entries and object members. Nova retains its
existing byte ceiling and per-tool schemas rather than imposing an arbitrary
new structural cap on accepted authoring payloads. Large media remains one
base64 string with the existing 50 MiB asset allowance plus framing.

The 1.32.1 SDK update is transitive through tooling/AI SDK, not Nova's own
server/client import surface. Its issuer-binding and request-limit fixes are
adopted by updating that transitive; Nova does not construct deprecated v1
OAuth client providers or own their credential storage.

### Fumadocs

The first consolidated `npm ci` reproduced a peer failure: MDX 15.4.7 requires
core `^16.17.0`, but #735 supplied 16.16.2. Align core/UI to cooldown-eligible
16.17.1; do not use force or legacy-peer-deps. Sources:
[16.17.0](https://github.com/fuma-nama/fumadocs/releases/tag/fumadocs%4016.17.0),
[16.17.1](https://github.com/fuma-nama/fumadocs/releases/tag/fumadocs%4016.17.1),
[MDX 15.4.7](https://github.com/fuma-nama/fumadocs/releases/tag/fumadocs-mdx%4015.4.7).

16.17 moves search highlighting to the CSS Custom Highlight API, introduces
provider-specific search hooks, retires old stringifiers/highlight results,
indexes tables by row, and derives processed Markdown/search records from the
authored source. Nova uses the stock RootProvider static search and
`createFromSource(source).staticGET`, not deprecated search hooks or custom
highlight/stringifier APIs. Regenerating MDX and the production build regenerates
the complete static search index and processed Markdown. Nova's custom code
theme, docs translations, page renderer and LLM routes retain their supported
interfaces. 16.17.1 additionally formats generated Markdown tables.

The build's CSS optimizer warns about `::highlight`; this is valid browser CSS
from Fumadocs, retained in the generated asset. It is not a source syntax error.
There is no local workaround or pinned older search implementation.

### Motion 14

[Changelog](https://github.com/motiondivision/motion/blob/v14.0.0/CHANGELOG.md).
The major removes internal compatibility APIs restored for mixed 13.0–13.4
installations and pins the internal package family together. Nova imports
public APIs from `motion/react`; no removed internals, deprecated timeline
range options, or direct framer-motion imports occur in production code.
The matching Fumadocs UI now also uses Motion 14, eliminating its nested
Motion 13 family. SVG reads, inherited animations and sibling mount ordering
receive the upstream fixes. Actual browser checks and full smoke CI cover the
animated Builder/chat/Preview surfaces; type-checking alone cannot prove them.

### music-metadata 12

[Release](https://github.com/Borewit/music-metadata/releases/tag/v12.0.0).
ES2023/Node 22 and file-type 22 align with Nova's Node 24 and existing
file-type 22. Nova's `lib/media/validate.ts` and standalone runtime probe use
public `parseBuffer` and format/duration metadata. No API replacement is
needed. Preserve the existing parser deadline, real-byte validation and narrow
MP3/WAV acceptance. The release also fixes prototype-named tags, picture
selection and omitted-tokenizer APEv2 metadata. Media tests parse real audio
and video bytes through the updated package.

### Radix primitives

Popover 1.2.0 adds `Title` and `Description`, and fixes focus/scroll interaction
for nested portals inside a modal. Adopt the new parts in Nova's Tiptap adapter:
link and image panels now have accessible names/descriptions; address and image
alternative-text inputs have explicit labels. Keep `data-inline-toolbar` and
mouse propagation behavior that prevent premature blur-save. A Chromium check
uses the real InlineTextEditor to enter a link and image, verifies panel names
and descriptions, and confirms focus/content survives the portal.
[Published source](https://github.com/radix-ui/primitives/blob/main/packages/react/popover/src/popover.tsx).
Dropdown-menu 2.1.25 follows menu/primitive fixes; Nova's remaining Tiptap menus
use that public adapter. Builder floating surfaces continue using Base UI.

### Tables and virtualization

[Table releases](https://github.com/TanStack/table/releases),
[virtual releases](https://github.com/TanStack/virtual/releases).
The admin user table already uses v9 `useTable`, explicit features/row-model
slots and `table.FlexRender`; it has no legacy hook or deprecated store reads.
9.2.5–8 update Store and bundled skills rather than requiring another app API
migration. The virtualizer fixes newly mounted rows under `directDomUpdates`
and reconciles pending index-scroll measurements. Nova's VirtualFormList owns
variable-height rows, dynamic range extraction, drag placeholders and cached
measurements; it does not enable direct DOM updates. Retain that layout ownership.

### Remaining updates

| Package | Upstream change and Nova decision |
| --- | --- |
| @codemirror/language 6.13.1 | Stream-parser types move to @codemirror/streamparser with a dependency correction. Nova's XPath language uses LRLanguage/Lezer, not StreamLanguage or the moved types. Keep its AST parser. [Changelog](https://github.com/codemirror/language/blob/main/CHANGELOG.md). |
| @lezer/lr 1.4.11 | Incremental LR runtime update. Nova consumes the generated XPath parser/runtime, with no internal runtime API access. The published package points to [the owning repository](https://code.haverbeke.berlin/lezer/lr), not the stale GitHub mirror linked by Dependabot. Parser/Preview checks and proof CI cover consumers. |
| @google-cloud/storage 8.3.0 | Auth clients move to google-auth-library 11/gaxios 7; the release's tools feature concerns Bun flags. Nova runs Node and uses Storage/Bucket/File operations in lib/storage/media.ts. Existing auth-library 11, generation preconditions and guarded object operations remain supported. [Changelog](https://github.com/googleapis/google-cloud-node/blob/main/handwritten/storage/CHANGELOG.md). |
| @sentry/nextjs 11.5.0 | Read all 11.2–11.5 releases: default server deduplication, route providers, AI token/cache telemetry fixes and repeated-init/close semantics. Nova initializes once per runtime and retains explicit server dataCollection privacy restrictions; no deprecated SENTRY_ORIGIN attribute use. The framework-owned instrumentation improvements apply automatically. [Changelog](https://github.com/getsentry/sentry-javascript/blob/11.5.0/CHANGELOG.md). |
| shadcn 4.21.4 | CLI/registry tooling update, not a runtime replacement for Nova's restyled component wrappers. Keep the authored design system and components.json. [Source](https://github.com/shadcn-ui/ui/tree/main/packages/shadcn). |
| @iconify-icons/tabler 2.0.4 | Icon data update; existing offline icon identities remain valid. Type-check and browser rendering exercise consumers. [Source](https://github.com/iconify/icon-sets). |
| @types/google.maps 3.66.6 | Maps declaration update; Nova's loader/Preview geographic field code remains type-correct. [Source](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/google.maps). |
| @types/node 24.19.2 | Declaration patch within the Node 24 runtime major. No runtime bump. [Source](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node). |
| happy-dom 20.14.6 | Test-environment patch. No production consumer; actual UI acceptance remains in Chromium. [Source](https://github.com/capricorn86/happy-dom/releases). |
| shell-quote 1.12.0 | Transitive tooling parser adds shell constructs and fixes quoting/escaping. Nova has no direct parser or process-substitution consumer; update the lockfile without inventing a runtime import. [Changelog](https://github.com/ljharb/shell-quote/blob/v1.12.0/CHANGELOG.md). |

## Verification and limits

Local checks: peer-tree inspection, type-check, lint/format, real media/MCP/chat
transport tests (39 tests), provider transport/structured-output/SA wire
checks (26 tests), and native Chromium link/image/formatting checks.
The production build regenerates docs/search/LLM artifacts. Full PR CI adds the
complete unit, Postgres, production-build, browser/app smoke and ordinary proof
lanes. Their exact final outcome is recorded on the consolidated PR.

No live provider schema call or paid quality trial is required for these
unchanged tool schemas/model settings. This audit does not claim production
deployment, live OAuth, native device rendering or served proof-reader acceptance.
Merge/deployment remains the user's approval boundary.
