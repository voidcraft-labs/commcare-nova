# Dependency audit, October 22, 2026

Consolidates Dependabot #780, #781, #793, #794 and #796. The proof-pins PR #734
is independent. Versions and transitive resolutions come from those five PRs,
except Next 16.4.2: 16.4.0 has three published security advisories, and 16.4.2
was published October 15, beyond the configured three-day patch cooldown.
Next stays exact-pinned. No unconstrained update or audit-fix command was used.

## Runtime and authoring

| Package and change | Upstream evidence and Nova decision |
| --- | --- |
| `next` 16.3.8 → 16.4.2 | [16.4 overview](https://nextjs.org/blog/next-16-4), [16.4.1 security fixes](https://github.com/vercel/next.js/releases/tag/v16.4.1), [16.4.2](https://github.com/vercel/next.js/releases/tag/v16.4.2). Smaller bundles, improved Turbopack memory/cache behavior and updated vendored React arrive automatically. Read the installed Cache Components guide: adoption changes route lifetime, prerendering and cache contracts across authenticated routes; it is a separate migration, not an obsolete API Nova must remove here. Existing proxy, standalone tracing and deployment-skew settings remain supported. |
| `react`, `react-dom` 19.3.0 → 19.3.1 | [Release](https://github.com/facebook/react/releases/tag/v19.3.1) improves RSC transport. App Router runs Next's vendored React; unit tests and component peers use these installed packages. Validate both boundaries in CI. |
| `ai` 7.0.137 → 7.0.142, `@ai-sdk/openai` 4.0.91 → 4.0.95, `@ai-sdk/react` 4.0.140 → 4.0.146 | [SDK comparison](https://github.com/vercel/ai/compare/ai%407.0.137...ai%407.0.142), [OpenAI comparison](https://github.com/vercel/ai/compare/%40ai-sdk%2Fopenai%404.0.91...%40ai-sdk%2Fopenai%404.0.95). Fixes custom transport replay, duplicate resumed parts, assistant message identity and stateless Responses replay. Nova uses `NovaChatTransport`, `useChat`, `addToolOutput` and stateless Responses. New `toolCallConcurrency` can bound SDK tool execution, but Nova already serializes mutations at the shared workspace used by SA, builds and MCP; replacing that owner with an SDK-only queue would lose cross-surface protection. No prompt, tool-schema or model change and no billable probe. |
| `better-auth` and `@better-auth/{api-key,cimd,core,mcp,oauth-provider}` 1.7.7 → 1.7.10 | [Full comparison](https://github.com/better-auth/better-auth/compare/v1.7.7...v1.7.10), [release](https://github.com/better-auth/better-auth/releases/tag/v1.7.10). Fixes migration foreign-key identity, session cleanup/error handling, OAuth consent reference isolation, DPoP URL checks, native loopback clients and protocol errors. Nova's Kysely migrations, Google OAuth, CIMD/DCR and MCP bearer/session boundaries get regression coverage. Startup resource-seed failure now leaves auth available and retries on first resource access. Update the old rejection test to prove the native lazy retry against real Postgres; independently retain Nova singleton pool-acquisition retry coverage. Optional private-key-JWT rotation is a client capability; Nova does not need another key-management UI. Keep the family aligned. |
| `@google-cloud/cloud-sql-connector` 1.12.0 → 1.12.1 | [Comparison](https://github.com/GoogleCloudPlatform/cloud-sql-nodejs-connector/compare/v1.12.0...v1.12.1). Dependency refresh; PostgreSQL proactive-probe change was reverted upstream. No connector API migration. |
| `google-auth-library` 11.1.0 → 11.3.0 | [Owning monorepo changelog](https://github.com/googleapis/google-cloud-node/blob/main/core/packages/google-auth-library-nodejs/CHANGELOG.md). Bun CLI flags and generated API refresh; Nova runs Node 24, not Bun. The old standalone repository's changelog ends at 10.x and is not authority for this update. CI's controlled auth transport probes cover the changed Google HTTP dependency graph. |
| `gpt-tokenizer` 4.0.0 → 4.0.3 | [Comparison](https://github.com/niieani/gpt-tokenizer/compare/4.0.0...4.0.3). Faster long-piece merging and corrected Unicode/special-token handling improve Nova's existing anatomy/context token estimates without changing tokenizer calls. |
| `music-metadata` 12.0.0 → 12.2.0 | [Comparison](https://github.com/Borewit/music-metadata/compare/v12.0.0...v12.2.0). Bounded metadata allocations, Ogg fixes and video-track timing. The real video-only MP4 now yields 520 ms; store that useful metadata and update the former missing-duration assertion and contract. Keep duration optional, no full-file duration scan, and retain real codec/container fixtures. CAF support does not expand Nova's independently proven media allowlist. |
| `undici` 8.11.2 → 8.12.1 | [Comparison](https://github.com/nodejs/undici/compare/v8.11.2...v8.12.1). HTTP/2 limits, abort/connection fixes and wrapper receive limits. Nova uses Agent/MockAgent for controlled native-fetch peers. New unsupported-FormData refusal does not change production's native browser upload path. Node's built-in fetch runtime is still pinned separately. |
| `zod` 4.6.5 → 4.6.7 | [Comparison](https://github.com/colinhacks/zod/compare/v4.6.5...v4.6.7). Checks collection size bounds before elements and fixes record typing. Existing schema construction remains supported; no projected tool schema change requiring paid acceptance calls. |

## UI and documentation

| Package and change | Upstream evidence and Nova decision |
| --- | --- |
| `@base-ui/react` 1.8.0 → 1.9.0 | [Release](https://github.com/mui/base-ui/releases/tag/v1.9.0). Faster large lists, subscription/listener cleanup, focus and retained-popup fixes. Audit `actionsRef`, `onItemHighlighted` and popup wrappers: Nova does not rely on the old actions-ref-implies-retained-mount behavior. No deprecated usage to preserve. New menu filtering is preview; Nova's searchable choices already use the supported Combobox. |
| `@tanstack/react-virtual` 3.14.14 → 3.14.21 | [Comparison](https://github.com/TanStack/virtual/compare/%40tanstack%2Freact-virtual%403.14.14...%40tanstack%2Freact-virtual%403.14.21). iOS touch/cancel/clamp/scroll corrections and visible viewport measurement benefit the form canvas and choice lists. Keep `initialOffset` plus `initialMeasurementsCache` restoration; these fixes do not replace that app-owned state. |
| `fumadocs-core`, `fumadocs-ui` 16.17.1 → 16.17.5 | [Releases](https://github.com/fuma-nama/fumadocs/releases/tag/fumadocs%4016.17.5), [search failure API](https://github.com/fuma-nama/fumadocs/releases/tag/fumadocs%4016.17.3). Faster page tree/search indexing and keyboard-scrollable MDX tables are automatic. Adopt `SearchDialog.error` through the complete `useStaticSearch` result; remove the custom error paragraph and use the two translation keys for Nova wording. The library now labels stale results and resets active selection on error. Existing production-browser docs journey covers a failed index load, refresh, real results, keyboard navigation and responsive layout. |
| `motion` 14.0.0 → 14.2.0 | [Comparison](https://github.com/motiondivision/motion/compare/v14.0.0...v14.2.0). Independent transform acceleration benefits Nova's existing `x`-based dock transitions automatically. Strict Mode derived-value, spring handoff and easing fixes require no API replacement. New imperative `animateLayout` does not replace the builder's geometry-derived Activity-aware glide. |
| `@types/google.maps` 3.66.6 → 3.66.7 | [Definitions history](https://github.com/DefinitelyTyped/DefinitelyTyped/commits/master/types/google.maps). Compile Nova's map/address controls with the updated declarations; no runtime dependency change. |
| `shadcn` 4.21.4 → 4.21.5 | [Comparison](https://github.com/shadcn-ui/ui/compare/shadcn%404.21.4...shadcn%404.21.5). Registry tooling and awaited MCP add command. Existing Nova-owned primitives must not be overwritten with registry defaults. |

## Development and transitive updates

| Package and change | Upstream evidence and Nova decision |
| --- | --- |
| `@playwright/test` 1.63.0 → 1.64.1 | [1.64](https://github.com/microsoft/playwright/releases/tag/v1.64.0), [1.64.1](https://github.com/microsoft/playwright/releases/tag/v1.64.1). New Chromium/WebKit, corrected routed CORS redirect, device screen descriptors and JSX compilation. Nova uses native production-browser tests, no deprecated screencast font-size option. Optional WebMCP, project defaults and shuffle do not replace the explicit native-discovery/seed partition contract. CI validates browser changes. |
| `vitest` 5.0.3 → 5.0.5 | [5.0.5](https://github.com/vitest-dev/vitest/releases/tag/v5.0.5). Quoted `--changed` filenames, cleanup after hook failure, mock release, cancellation and crash reporting. Nova's `.mts` config, force-rerun triggers, owned resources and reporters use supported APIs. |
| `@testcontainers/postgresql` 12.2.0 → 12.2.1 | [Comparison](https://github.com/testcontainers/testcontainers-node/compare/v12.2.0...v12.2.1). Reaper ownership, longer host-port binding wait and declared dependencies. Existing global Postgres setup owns teardown; real database CI covers migrations and auth. |
| `lefthook` 2.1.16 → 2.2.2 | [Comparison](https://github.com/evilmartians/lefthook/compare/v2.1.16...v2.2.2). Worktree-specific patches/backups and merge-base push-file selection directly benefit this workflow; existing staged-file formatting and pre-push type checking remain supported. |
| `happy-dom` 20.14.6 → 21.0.1 | [Release](https://github.com/capricorn86/happy-dom/releases/tag/v21.0.0). CSS and iframe network loading default off; `disableCSSFileLoading` is deprecated. Nova uses it only for React lifetime tests, has no old setting and needs no network-loading opt-in. Layout, iframe and media playback remain native-browser responsibilities. |
| `vite` 8.2.2 → 8.3.5 | [Changelog](https://github.com/vitejs/vite/blob/v8.3.5/packages/vite/CHANGELOG.md). Transitive through Vitest, Fumadocs MDX and the exact-pinned profiler. Resolution, optimizer, HMR and SSR fixes; no direct Nova Vite server to migrate. Preserve the profiler package/hash pin. Rolldown and bindings use #793's resolutions. |
| `hono` 4.13.7 → 4.13.13 | [Release](https://github.com/honojs/hono/releases/tag/v4.13.13). Transitive through the profiler's MCP SDK, not Nova's Next routes. `app.mount` is deprecated in favor of mount middleware, but Nova imports neither API. Take security fixes without inventing a direct Hono adapter. |
| `markdown-it` 14.3.1 → 14.3.3 | [Changelog](https://github.com/markdown-it/markdown-it/blob/14.3.3/CHANGELOG.md). Security backports through `tiptap-markdown` and `prosemirror-markdown`. Retain the parent's supported major, not a direct 15.x override. |

The grouped lockfile also advances the SDK/auth/framework sibling packages,
Google transport libraries, browser compatibility data, Motion internals and
platform binaries. These are the upstream PR resolutions rather than a fresh
global solve. `npm ci` verifies peers and package-lock consistency.

The final install reports eight remaining advisory entries, from the shadcn
CLI's registry/glob chain and Testcontainers' `ip-address`. No blanket audit
fix or downgrade to the registry's suggested shadcn 1.0.0 is part of this work.
The Next critical advisory entry is removed by the eligible patch.
