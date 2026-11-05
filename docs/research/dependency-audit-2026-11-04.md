# Dependency audit, November 4, 2026

Consolidates Dependabot #806, #807, #808, #835, #842 and #859 from main
`ab43bf09`. The routine group supplies its exact lockfile resolutions; the
three additional transitive entries come verbatim from their security PRs.
The routine group's happy-dom and undici already cover #807 and #806.
No unconstrained update, audit-fix, model probe or paid schema call was run.
The five-day minor and three-day patch cooldown policy remains unchanged.
The proof-pins PR #734 is unrelated.

## Source review and Nova decisions

Reviewed installed old/new package code, declarations and bundled changelogs,
including source-map originals for MCP, TipTap, virtual scrolling and Markdown.
Hashed bundle renames and regenerated declarations are distinguished from API
changes. The decisions below follow Nova's actual consumers.

| Family | Change and Nova impact |
| --- | --- |
| AI SDK / OpenAI / React | [SDK comparison](https://github.com/vercel/ai/compare/ai%407.0.142...ai%407.0.157), [provider comparison](https://github.com/vercel/ai/compare/%40ai-sdk%2Fopenai%404.0.95...%40ai-sdk%2Fopenai%404.0.105). The new `interrupted` finish reason represents EOF without a provider completion signal and emits no error by itself. Add it to the log schema; reject it before durable model-step completion or tool dispatch; refuse partial structured objects; route ordinary edits through failure settlement while retaining text. Local HTTP peers run the actual SDK for regression evidence. Provider-specific reasoning now passes through unchanged; Nova already supplies its canonical medium effort, stateless compaction and prompt-cache configuration. Stable `LanguageModelStreamPart` / `filterActiveTools` aliases replace experimental names upstream; Nova uses none of the deprecated aliases, low-memory flag or webSearchPreview. New steering, speech and prewarming APIs serve capabilities Nova does not currently offer. History-validation removal does not replace Nova's persisted-message and authored-tool gates. |
| Better Auth family | [Comparison](https://github.com/better-auth/better-auth/compare/v1.7.10...v1.7.14). CIMD refresh preserves concurrent administrator controls; stricter ID-token claim/algorithm verification and shared JWKS handling apply to social sign-in; type-only exports and provider configuration are corrected. Nova uses Google sign-in, UUID keys, Kysely, CIMD/DCR and the MCP verifier. Keep the whole family at 1.7.14; no Cloudflare/Vercel provider configuration or TOTP import to migrate. Existing real-Postgres auth and native HTTP suites cover the active boundaries. |
| MCP client/server | [Comparison](https://github.com/modelcontextprotocol/typescript-sdk/compare/v2.3.1...v2.4.0). Adds optional Skills extension subpaths, forwarded subscription params, scoped refresh support, root-definition schema recognition, stricter numeric custom-header declarations, and modern per-request transport binding. Nova already constructs a request-scoped McpServer and uses handler contexts; no deprecated client-identity accessor or numeric x-mcp-header declaration. Serving Skills would be a new product surface, not a replacement for Nova's shared app tools. Keep the request-scoped lifecycle and run transport/schema CI. |
| Next | [16.4.3](https://github.com/vercel/next.js/releases/tag/v16.4.3). Backports font URL, proxy runtime loading, standalone React bootstrap and request trace fixes; no feature migration. Read installed upgrade guide. Nova's proxy, standalone output, action encryption key and deployment ID remain supported. Production build and native browser CI exercise the emitted artifact, including Next's vendored React. |
| Sentry | [Comparison](https://github.com/getsentry/sentry-javascript/compare/11.5.0...11.9.0). Browser pageload tracing now waits for streamed trace metadata and settles pending waits on navigation; build/server wrappers also change. Nova retains its two-channel logger, tunnel and existing wrappers. No new replay collection or tracing policy is introduced. |
| TipTap family | [Comparison](https://github.com/ueberdosis/tiptap/compare/v3.31.4...v3.32.0). Core supports external schema specs and cross-item-type list conversion; React selectors use circularDeepEqual to avoid stack overflow on editor state. Existing extension-based Nova prose remains supported and automatically gets the fixes. A parallel external schema is unnecessary. Image, table, marks, starter-kit and suggestion align to the same release; several are version-only updates. Native editing/focus/list tests remain the behavioral evidence. |
| Radix | Dropdown/popover/controllable-state changes are declaration compatibility (`undefined` and bivariant callbacks), with unchanged shipped runtime code. Existing TipTap primitives and reasoning control require no migration. |
| CodeMirror / Lezer | Autocomplete handles keyboard events without `key`; Lezer corrects repeat-node lookahead offsets and buffer reuse. Nova's identity-backed XPath parser/editor uses these APIs unchanged. Parser tests and native expression editing cover the consumers. |
| TanStack | React Table fixes AppTable subscription updates; virtual-core fixes ResizeObserver delivery/re-observation and touch momentum scroll commands. Nova's case/lookup tables and virtual lists get the fixes through existing APIs. No table architecture replacement is required. |
| Immer / Zustand | Immer fixes assigned/reordered draft finalization, Set/Map handling and readonly-array types; new isModified is optional. Zustand fixes devtools subscription cleanup, serialized revivers and hydration snapshots. Nova still needs canonical mutation diffs rather than a draft-modified boolean, and already owns store cleanup. Reducer, undo, reconciliation and native builder coverage run unchanged. |
| Fumadocs | [Comparison](https://github.com/fuma-nama/fumadocs/compare/fumadocs-core%4016.17.5...fumadocs-core%4016.17.9). Static search switches its internal engine to ZBSearch; Nova's useStaticSearch and createFromSource.staticGET are the supported matched pair. No initOrama/oramaStaticClient/useDocsSearch alias is used. MDX loader/config handling and server code-block APIs change; Nova uses the supported generated source and existing highlighter. Native docs search, hydration and production compilation cover this boundary. |
| File-type / music-metadata | Added bounded read-buffer options and format-specific allocation/list limits, plus container/chapter parsing fixes. Nova uses byte-buffer sniffing, explicit upload caps and skipCovers; no chapter UI or file-system traversal API. Existing supported media partitions remain authoritative, so newly recognized formats do not silently become attachable. Real-byte media tests exercise validation. |
| gpt-tokenizer | Adds mutable incremental counting and faster bounded merge caching. Nova anatomy counts immutable text snapshots with digest memoization through o200k_base; incremental edit state would add retention without matching this consumer. Existing counting automatically gets implementation improvements; estimates remain distinct from billed usage. |
| Motion | [Comparison](https://github.com/motiondivision/motion/compare/v14.2.0...v14.8.0). Animation/layout/transform/gesture internals and Remix entrypoint evolve. Existing AnimatePresence/motion consumers remain supported; Nova has no Remix route to migrate. Browser animation, focus and virtual-list checks remain required. |
| Markdown-to-JSX | Parser fixes blank-line/edge handling and nested link/image scanning; declaration adds notAtEdge. Existing Markdown rendering uses public APIs; no parser fork needed. |
| Google libraries | KMS/storage 6.3.0/8.4.0 are regenerated API/package updates with unchanged installed code in Nova's active entries. Auth library lowers payload diagnostics to debug, preserves configured JWT defaults and deprecates generic credentials/fromJSON/fromStream construction. Nova uses ADC through constructors, not those deprecated entrypoints; no credential migration. |
| shadcn / icons / Maps types | CLI registry/search and generated declaration updates, icon SVG data/ID caching, and Maps type additions. Nova's checked-in primitives, explicit icon data and Maps loader remain supported. No automatic component overwrite or new external icon fetching. |
| Biome | 2.6.3 adds recommended checks and Markdown/YAML formatting. Adopt number min/max simplifications and distinct test suite titles. Keep new component-factory checks on production code, with explicit false-positive suppressions for TipTap key handlers and the native Date constructor; test-local harnesses are lifetime fixtures. Disable the broken Playwright describe heuristic (also matches Zod.describe and rejects the valid options overload). Rendered innerText in browser acceptance intentionally differs from textContent. Keep Markdown/YAML formatting explicitly off, preserving existing source/prompt formatting rather than creating an unrelated repository rewrite. |

## Additional security PRs

- `@hono/node-server` 2.1.1 → 2.1.6: [comparison](https://github.com/honojs/node-server/compare/v2.1.1...v2.1.6). Reject raw backslash request paths, bind WebSocket URL host to Host, handle resets during asynchronous upgrades, abort reset HTTP/2 requests, and restrict static files to GET/HEAD. Reachable through the profiler's legacy MCP SDK, not Nova's Next HTTP adapter. No direct Hono API migration. Profiler entrypoint hashes and pinned versions remain unchanged; postinstall hardening passes.
- `systeminformation` 5.33.15 → 5.33.19: [comparison](https://github.com/sebhildebrandt/systeminformation/compare/v5.33.15...v5.33.19). Command/input handling fixes in OS/device/network collectors; reachable through shadcn → dotenvx, not Nova's request data path. No direct import.
- `fast-uri` 3.1.8 → 3.1.9: [comparison](https://github.com/fastify/fast-uri/compare/v3.1.8...v3.1.9). URI normalization preserves relative-reference meaning, escapes first-segment colons and rejects invalid host characters. Reachable through Ajv used for authored JSON Schema verification and legacy MCP. No URI manipulation fork or override.
- happy-dom 21.0.4 closes ESM compilation, cross-origin iframe, redirect authorization and renderer proxy issues; undici 8.12.3 includes the 8.12.2 TLS/cache/decompression/SRI/EventSource/WebSocket security fixes plus its follow-up. Nova uses happy-dom only for component lifetime tests and Undici through its owned provider transports and native HTTP test peers.

## Direct resolved versions

| Package | Before | After |
| --- | --- | --- |
| `@ai-sdk/openai` | 4.0.95 | 4.0.105 |
| `@ai-sdk/react` | 4.0.146 | 4.0.161 |
| `@better-auth/api-key` | 1.7.10 | 1.7.14 |
| `@better-auth/cimd` | 1.7.10 | 1.7.14 |
| `@better-auth/core` | 1.7.10 | 1.7.14 |
| `@better-auth/mcp` | 1.7.10 | 1.7.14 |
| `@better-auth/oauth-provider` | 1.7.10 | 1.7.14 |
| `@codemirror/autocomplete` | 6.20.3 | 6.20.4 |
| `@google-cloud/kms` | 6.2.1 | 6.3.0 |
| `@google-cloud/storage` | 8.3.0 | 8.4.0 |
| `@iconify/react` | 6.0.2 | 6.0.3 |
| `@lezer/common` | 1.5.3 | 1.5.4 |
| `@modelcontextprotocol/server` | 2.3.1 | 2.4.0 |
| `@radix-ui/react-dropdown-menu` | 2.1.25 | 2.2.1 |
| `@radix-ui/react-popover` | 1.2.0 | 1.3.1 |
| `@radix-ui/react-use-controllable-state` | 1.2.6 | 1.3.0 |
| `@sentry/nextjs` | 11.5.0 | 11.9.0 |
| `@tanstack/react-table` | 9.2.8 | 9.3.1 |
| `@tanstack/react-virtual` | 3.14.21 | 3.14.24 |
| `@tiptap/extension-image` | 3.31.4 | 3.32.0 |
| `@tiptap/extension-list` | 3.31.4 | 3.32.0 |
| `@tiptap/extension-mention` | 3.31.4 | 3.32.0 |
| `@tiptap/extension-subscript` | 3.31.4 | 3.32.0 |
| `@tiptap/extension-superscript` | 3.31.4 | 3.32.0 |
| `@tiptap/extension-table` | 3.31.4 | 3.32.0 |
| `@tiptap/extension-table-cell` | 3.31.4 | 3.32.0 |
| `@tiptap/extension-table-header` | 3.31.4 | 3.32.0 |
| `@tiptap/extension-table-row` | 3.31.4 | 3.32.0 |
| `@tiptap/pm` | 3.31.4 | 3.32.0 |
| `@tiptap/react` | 3.31.4 | 3.32.0 |
| `@tiptap/starter-kit` | 3.31.4 | 3.32.0 |
| `@tiptap/suggestion` | 3.31.4 | 3.32.0 |
| `@types/google.maps` | 3.66.7 | 3.66.9 |
| `ai` | 7.0.142 | 7.0.157 |
| `better-auth` | 1.7.10 | 1.7.14 |
| `file-type` | 22.1.1 | 22.2.0 |
| `fumadocs-core` | 16.17.5 | 16.17.9 |
| `fumadocs-mdx` | 15.4.7 | 15.4.10 |
| `fumadocs-ui` | 16.17.5 | 16.17.9 |
| `gpt-tokenizer` | 4.0.3 | 4.1.0 |
| `immer` | 11.1.21 | 11.2.9 |
| `kysely` | 0.29.6 | 0.29.7 |
| `markdown-to-jsx` | 9.10.3 | 9.10.4 |
| `motion` | 14.2.0 | 14.8.0 |
| `music-metadata` | 12.2.0 | 12.3.2 |
| `next` | 16.4.2 | 16.4.3 |
| `shadcn` | 4.21.5 | 4.23.0 |
| `undici` | 8.12.1 | 8.12.3 |
| `zustand` | 5.0.15 | 5.0.16 |
| `@biomejs/biome` | 2.5.15 | 2.6.3 |
| `@iconify-icons/tabler` | 2.0.4 | 2.0.5 |
| `@modelcontextprotocol/client` | 2.3.1 | 2.4.0 |
| `google-auth-library` | 11.3.0 | 11.3.2 |
| `happy-dom` | 21.0.1 | 21.0.4 |

The remaining transitive updates are the grouped PR's resolved sibling packages,
engines, transport libraries and platform artifacts, not a fresh registry solve.
The install reports 22 advisory entries (2 low, 17 moderate, 3 high). Retain the
scope: no blanket audit fix or unrelated parent-major override. Deprecated
node-domexception and glob 10 remain parent-owned through the Google SQL connector
and Testcontainers chains; Nova does not import their APIs directly.

## Verification

`npm ci` succeeds with the strict install-script policy and profiler hash check.
Local lint, type checking, real-SDK completion/interruption checks and CI results
are recorded in the pull request. No live model traffic or billable evaluation.
