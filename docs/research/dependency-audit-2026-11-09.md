# Dependency audit, 9 November 2026

## Scope and provenance

This audit combines Dependabot #889 (`b111b161d6f2211b57355636916baf7f55932005`)
and #890 (`7b65e7e11e0bcfe56882a1bf29456b2a8cb0a9ab`) on main
`1f669dad`. The patches were applied relative to each bot commit's parent;
current-main changes were preserved. The unrelated GitHub Actions proof-pin
PR #734 is outside this audit.

The only overlapping patch context was the root dependency list. Every final
non-root lockfile record equals a record in main or one of the two bot proposals;
there are no additional resolutions. `npm ci` passed with Node 24.21.0 and npm
12.0.2 through mise, with the existing strict install-script and remote-tarball
policies. No override, runtime, ignored package, or profiler pin changes.
The proposed versions retain Dependabot's five-day minor and three-day patch
cooldowns. Installed old and new package bytes, public exports, declarations,
engines and peer dependencies were compared. Families with exact peers stay
aligned. Renamed bundle chunks were compared after normalizing their hash suffix;
markdown-to-jsx source maps supplied its original parser changes.

## Exact direct versions

| Package | Before | After |
| --- | --- | --- |
| `@ai-sdk/openai` | 4.0.105 | 4.0.109 |
| `@ai-sdk/react` | 4.0.161 | 4.0.167 |
| `@better-auth/api-key` | 1.7.14 | 1.7.18 |
| `@better-auth/cimd` | 1.7.14 | 1.7.18 |
| `@better-auth/core` | 1.7.14 | 1.7.18 |
| `@better-auth/mcp` | 1.7.14 | 1.7.18 |
| `@better-auth/oauth-provider` | 1.7.14 | 1.7.18 |
| `@iconify/react` | 6.0.3 | 6.0.4 |
| `@lezer/common` | 1.5.4 | 1.5.5 |
| `@lezer/lr` | 1.4.11 | 1.4.12 |
| `@tanstack/react-virtual` | 3.14.24 | 3.14.26 |
| `@tiptap/extension-image` | 3.32.0 | 3.32.3 |
| `@tiptap/extension-list` | 3.32.0 | 3.32.3 |
| `@tiptap/extension-mention` | 3.32.0 | 3.32.3 |
| `@tiptap/extension-subscript` | 3.32.0 | 3.32.3 |
| `@tiptap/extension-superscript` | 3.32.0 | 3.32.3 |
| `@tiptap/extension-table` | 3.32.0 | 3.32.3 |
| `@tiptap/extension-table-cell` | 3.32.0 | 3.32.3 |
| `@tiptap/extension-table-header` | 3.32.0 | 3.32.3 |
| `@tiptap/extension-table-row` | 3.32.0 | 3.32.3 |
| `@tiptap/pm` | 3.32.0 | 3.32.3 |
| `@tiptap/react` | 3.32.0 | 3.32.3 |
| `@tiptap/starter-kit` | 3.32.0 | 3.32.3 |
| `@tiptap/suggestion` | 3.32.0 | 3.32.3 |
| `ai` | 7.0.157 | 7.0.163 |
| `better-auth` | 1.7.14 | 1.7.18 |
| `entities` | 8.1.0 | 9.0.0 |
| `file-type` | 22.2.0 | 22.3.0 |
| `fumadocs-core` | 16.17.9 | 16.17.10 |
| `fumadocs-ui` | 16.17.9 | 16.17.10 |
| `kysely` | 0.29.7 | 0.29.8 |
| `markdown-to-jsx` | 9.10.4 | 9.10.5 |
| `motion` | 14.8.0 | 14.9.1 |
| `music-metadata` | 12.3.2 | 12.3.5 |
| `next` | 16.4.3 | 16.4.5 |
| `@biomejs/biome` | 2.6.3 | 2.6.5 |
| `@bufbuild/cel` | 0.6.1 | 0.6.2 |
| `@tailwindcss/postcss` | 4.3.3 | 4.3.4 |
| `google-auth-library` | 11.3.2 | 11.3.3 |
| `rregex` | 1.13.1 | 1.13.5 |
| `tailwindcss` | 4.3.3 | 4.3.4 |
| `vitest` | 5.0.5 | 5.1.0 |

## Adoption decisions

### Kysely and the persisted lookup audit

[Kysely 0.29.8](https://github.com/kysely-org/kysely/releases/tag/v0.29.8)
discards connections whose rollback fails and throws `AbortedTransactionError`
when PostgreSQL answers COMMIT with ROLLBACK. The published Postgres driver and
controlled-transaction implementation confirm both changes.

The grouped PR's failed Postgres test exposed a production scanner bug:
`persistedLookupReferenceScan.ts` caught a failed SQL read inside a shared
repeatable-read transaction, then kept reading the aborted transaction. Even
before this upgrade, later reads could report spurious failures. Each recoverable
SQL read now owns a savepoint. A read failure rolls back and releases that
savepoint before the scanner classifies the original error, retaining the same
read-only snapshot for independent reads and subsequent apps. Assembly and
extraction failures remain ordinary per-app observations.

Real Postgres regressions use a view that raises for the first app only, once
for blueprint rows and once for stored reference rows. Both require the original
error, a clean comparison of the next app, and unchanged persisted data. Sibling
scan scripts catch outside their per-app transactions or let SQL failure reject;
no general transaction behavior is weakened.

### Entities and the XML boundary

[Entities 9](https://github.com/fb55/entities/releases/tag/v9.0.0) replaces the
streaming decoder API and removes old decode tables and `getCodePoint`. Nova
imports only supported synchronous `encodeXML`, `decodeHTML`, and `decodeXML`.
The published `src` and exports retain those APIs. Nested HTML parsers keep
their compatible older entities copies; there is no forced transitive major.

`encodeXML` now emits decimal numeric references. Nova adopts that spelling;
its explicit whitespace references still preserve XML attribute tab/LF/CR and
text CR. The XML boundary regression keeps its raw-value, parse-roundtrip and
nonmutation assertions, with decimal C1 references in the exact encoded value.

Seven retained HQ responses for `targeted-hq-side-state` are copied directly from
HQ's output in [the original #890 run](https://github.com/voidcraft-labs/commcare-nova/actions/runs/42618807555),
artifact `proof-out-1-3`, block
`f1f68e797a22f15eafb4e977c7691d30799195bc0d82467aa93864baa0979d59`.
Every changed file was checked: replacing hexadecimal references with their
identical decimal code points accounts for the complete byte difference.
The retained-read comparison itself is unchanged and must pass again in PR CI.

### AI SDK

The package-owned changelogs for [ai](https://github.com/vercel/ai/blob/ai%407.0.163/packages/ai/CHANGELOG.md),
[OpenAI](https://github.com/vercel/ai/blob/%40ai-sdk/openai%404.0.109/packages/openai/CHANGELOG.md)
and [React](https://github.com/vercel/ai/blob/%40ai-sdk/react%404.0.167/packages/react/CHANGELOG.md)
were checked against bundled source, particularly Responses argument serialization,
model capabilities, stream handling, telemetry and UI message conversion.

Responses replay now preserves valid JSON-string arguments and supports bigint
and cycle serialization. Credentials can resolve asynchronously per request; Nova's
explicit string key and owned Undici transport remain supported. The model catalog
refactor keeps the configured Responses behavior; existing model-step and durable
model-context tests exercise actual SDK requests against local HTTP peers.

The new `ping` stream variant is optional Anthropic behavior and is not stored
as generated content or forwarded into UI messages. Nova's OpenAI stream drains
select reasoning, text, errors and aborts, and already reject `interrupted`
completion in model steps and structured extraction. New steering messages require
SDK steering, which Nova does not configure. Streamed data-schema lookup is fixed
upstream; Nova does not pass `dataPartSchemas`. No new exhaustive-switch migration
is needed. Nova uses neither deprecated URL tool-result parts nor experimental
MCP renderer/prompt APIs that gained stable names.

Realtime, video, image, transcription, sandbox, Azure and provider-hosted tunnel
additions do not justify new Nova surfaces. Telemetry recording flags now also
filter nested integration events; no diagnostic content capture is added. Model
prompts, tools, schemas and model configuration are unchanged, so no model-context
version or dependent plugin update is needed. No paid provider probe was run.

### Authentication

[Better Auth 1.7.15](https://github.com/better-auth/better-auth/releases/tag/v1.7.15),
[1.7.16](https://github.com/better-auth/better-auth/releases/tag/v1.7.16),
[1.7.17](https://github.com/better-auth/better-auth/releases/tag/v1.7.17) and
[1.7.18](https://github.com/better-auth/better-auth/releases/tag/v1.7.18)
were compared with published adapter, session, organization, social provider,
API-key, CIMD and OAuth-provider code. The whole family remains at 1.7.18.

Relevant automatic fixes include strict verified-email conversion, redirect
refusal during credential exchange, session-store checks on sensitive actions,
organization role parsing and invitation visibility, hook response headers, and
CIMD transport rejection of invalid Response metadata. Nova retains Postgres
sessions, its compact cookie cache, live account-active checks, Google OAuth,
static Project roles and explicit invitation permissions. It does not use
secondary session storage, MySQL, phone auth or Better Auth's `getTestInstance`.
API-key sessions receive the upstream outside-store marker; no replacement
session implementation is needed. Existing real-adapter authentication, bearer,
discovery and sharing tests remain the acceptance boundary.

### Framework, rendering and tools

| Family and primary source | Actual Nova consumer and adoption |
| --- | --- |
| [Next 16.4.4](https://github.com/vercel/next.js/releases/tag/v16.4.4), [16.4.5](https://github.com/vercel/next.js/releases/tag/v16.4.5) | Adopt security fixes in response framing, image sniffing, Edge cookie headers and cache isolation, plus Turbopack startup fixes. Published `send-response`, image detector, web adapter and cache wrapper were inspected. Nova uses standalone Node App Router and no `use cache`/`unstable_cache` composition. Its deployment ID, Server Action key and native external packages stay configured. Shipped deploymentId, serverActions and output guides were read. Both old and new Next vendor React `19.3.0-canary-278794d7-20261002`; installed test React remains 19.3.1. Production-image and browser CI establish compatibility. |
| [TipTap 3.32.3](https://github.com/ueberdosis/tiptap/releases/tag/v3.32.3) | Keep the complete family aligned. Inspected core commands and resizable-view teardown, list deletion, table markup recreation, suggestion prefix escaping and React node-view changes. ReactRenderer stops flushing synchronously inside effects; EditorContent refreshes the ProseMirror root. These apply to Nova's rich-text editors without API changes. Nova's identity-based prose codec stays authoritative; upstream Markdown additions do not replace it. Link defaultProtocol and placeholder fixes arrive through aligned siblings. |
| [TanStack virtual-core changelog](https://github.com/TanStack/virtual/blob/main/packages/virtual-core/CHANGELOG.md) | React adapter changes are dependency-only, taking virtual-core 3.19.9 to 3.19.11. Source clamps overscrolled ranges after list shrink and reads fresh measurements for scroll-to-index; horizontal RTL gets the correct offset sign. Nova's vertical Preview form list benefits with its existing supported virtualizer options. |
| [Motion 14.9.1 changelog](https://github.com/motiondivision/motion/blob/v14.9.1/CHANGELOG.md) | `motion`, `framer-motion` and `motion-dom` align at 14.9.1; motion-utils stays 14.7.0. Inspected exit/remount, layout projection and WAAPI cleanup changes. Existing AnimatePresence and motion components receive the fixes. New function drag constraints and keepValuesOnRemount are explicitly internal; Nova does not adopt them. Reorder keyboard changes do not replace Nova's pragmatic-drag-and-drop implementation. |
| [Fumadocs source](https://github.com/fuma-nama/fumadocs/tree/main/packages/core) | Published 16.17.10 fixes multilingual MCP page lookup and multiple-root MDX file trees. The UI bump aligns its core peer; hash-normalized loader chunks are unchanged. Nova's existing MDX, source loader and static search remain supported. The repository changelog does not provide a distinct 16.17.10 entry, so conclusions use the owning published bytes rather than unrelated newer notes. |
| [markdown-to-jsx changelog](https://github.com/quantizor/markdown-to-jsx/blob/main/CHANGELOG.md) | 9.10.5 fixes opt-in relaxed ATX headings and spaces inside inline HTML. Source-map parser/type changes confirm defaults remain strict. Nova keeps `disableParsingRawHTML: true` for chat and Preview, including derived label options, and does not opt into relaxed headings. 9.10.6's raw-HTML security changes are outside the proposal and were published 6 November at 21:16 UTC, still inside the patch cooldown at this audit; no scope expansion. |
| [Lezer common](https://github.com/lezer-parser/common), [LR](https://github.com/lezer-parser/lr) | Published runtime diffs fix reused repeat nodes, mixed-parser mounts/stopped fragment bounds and safe incremental reuse. Declarations and exports retain Nova's CodeMirror/XPath APIs. Public changelogs lag these package versions; the exact installed runtime diff is the evidence. No grammar regeneration or regex substitute is needed. |
| [Iconify React](https://github.com/iconify/iconify/tree/main/components/react) | Published online API fallback adds a second host and longer timeout/rotation defaults. Nova imports `@iconify/react/offline` with local icon data, whose runtime is unchanged. No remote icon fetching is introduced. |
| [file-type 22.3](https://github.com/sindresorhus/file-type/releases/tag/v22.3.0), [music-metadata releases](https://github.com/Borewit/music-metadata/releases/tag/v12.3.5) | Media validation and document extraction keep supported buffer APIs. Inspected bounded EBML traversal and ZIP limits, plus audio/container duration and tag parsing fixes across 12.3.3–12.3.5. No new media format is admitted automatically; Nova's platform verdicts remain authoritative. |
| [Tailwind 4.3.4](https://github.com/tailwindlabs/tailwindcss/releases/tag/v4.3.4) | Core/PostCSS/oxide align. Candidate parsing, scope flattening, source watching, URL rewriting and compiler cleanup fixes apply through the existing PostCSS integration. The optional new Turbopack loader is not required and would add an unproposed package. |
| [Biome 2.6.5](https://github.com/biomejs/biome/releases/tag/%40biomejs%2Fbiome%402.6.5) | Native binaries align with the CLI. Existing strict lint configuration passes without disabling rules or repository-wide formatting churn. |
| [Vitest 5.1](https://github.com/vitest-dev/vitest/releases/tag/v5.1.0) | Published runner/types and release notes add last-failed/since-last-run, attempt results, timers support and cache/mock fixes. Nova retains its unit/Postgres project ownership, reporters, changed-test policy and teardown enforcement. Native Playwright remains its browser boundary; no Vitest browser migration. |
| [CEL](https://github.com/bufbuild/cel-es) | Published 0.6.2 changes correct CommonJS default/namespace interop; ESM runtime and public API stay unchanged. Nova's infrastructure condition tests use the actual CEL parser/planner. |
| [Google auth library](https://github.com/googleapis/google-cloud-node/tree/main/core/packages/google-auth-library-nodejs) | Published 11.3.3 fixes AWS FIPS signing service names. Nova's CI health probe uses GoogleAuth, not AWS federation; existing supported API stays. |
| [rregex 1.13.4](https://github.com/2fd/rregex/releases/tag/v1.13.4), [1.13.5](https://github.com/2fd/rregex/releases/tag/v1.13.5) | Inspecting exports catches a breaking standalone-global/type-path change despite patch versioning. Nova uses the supported root ESM RRegex export only in served MCP schema tests. New per-instance limits are optional; wasm allocator and result construction improve automatically. Existing actual Rust-regex schema compilation is retained. |

## Residual advisories

The read-only `npm audit` reports 22 affected package entries: 2 low, 17 moderate,
3 high. These are entries, not 22 independent advisories. The high paths are
nested Undici under frozen `@ai-sdk/workflow` and nested Zod under the deliberately
audited/pinned `agent-react-devtools` (also reported as an affected parent).
Root Undici remains 8.12.4; Node's bundled Undici is separately 7.29.1.

Moderate paths include glob/minimatch through archive/testcontainers, Sentry,
shadcn/ts-morph and Google SQL tooling; low deepmerge reaches shadcn's registry.
No broad override, ignored Workflow major, profiler repin or audit fix was applied.
This update is not whole-tree advisory clearance.

## Verification

Strict `npm ci`, lint and type-check passed. The focused real-Postgres scanner
and XML boundary run passed 79 tests. The full local unit suite passed 1,235
files and 18,669 tests. Both new SQL-failure regressions fail with
`AbortedTransactionError` when run against the original scanner implementation.
Exact-head PR CI results are recorded in the PR; the PR proof lane has no served readers, and
its optional audit sample may be skipped. No production or paid model action
is part of this audit.
