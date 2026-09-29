# Dependency audit, September 29, 2026

This integrates Dependabot #694 against main `982d2630`, with the approved
Pragmatic Drag and Drop core/Hitbox majors required by its auto-scroll patch.
The decision includes published release notes, installed source and types,
Nova consumers, and behavior checks, not just version numbers or existing CI.

## Release age

`.github/dependabot.yml` requires five days for minors/majors and three days
for patches. npm registry `time[version]` was checked at
2026-09-29 22:54:48 UTC. Every direct upgrade below qualifies. The two additional
majors were published September 24 at 01:55 UTC (core) and 01:54 UTC (Hitbox),
more than five full days before this audit. No cooldown exception is needed.
Versions below are resolved lockfile versions; `@lezer/common` was already
1.5.2 even though its previous manifest minimum was 1.5.1.

| Package | Previous | Adopted | Published (UTC) | Minimum days |
| --- | --- | --- | --- | --- |
| `@ai-sdk/openai` | 4.0.71 | 4.0.75 | 2026-09-24 | 3 |
| `@ai-sdk/react` | 4.0.110 | 4.0.117 | 2026-09-24 | 3 |
| `@atlaskit/pragmatic-drag-and-drop` | 3.1.0 | 4.0.0 | 2026-09-24 | 5 |
| `@atlaskit/pragmatic-drag-and-drop-auto-scroll` | 3.2.0 | 3.2.1 | 2026-09-24 | 3 |
| `@atlaskit/pragmatic-drag-and-drop-hitbox` | 2.2.2 | 3.0.0 | 2026-09-24 | 5 |
| `@better-auth/api-key` | 1.7.5 | 1.7.6 | 2026-09-24 | 3 |
| `@better-auth/cimd` | 1.7.5 | 1.7.6 | 2026-09-24 | 3 |
| `@better-auth/core` | 1.7.5 | 1.7.6 | 2026-09-24 | 3 |
| `@better-auth/mcp` | 1.7.5 | 1.7.6 | 2026-09-24 | 3 |
| `@better-auth/oauth-provider` | 1.7.5 | 1.7.6 | 2026-09-24 | 3 |
| `@googlemaps/js-api-loader` | 2.1.1 | 2.1.3 | 2026-09-22 | 3 |
| `@lezer/common` | 1.5.2 | 1.5.3 | 2026-09-24 | 3 |
| `@lezer/highlight` | 1.2.3 | 1.2.4 | 2026-09-24 | 3 |
| `@sentry/nextjs` | 10.75.0 | 10.75.3 | 2026-09-23 | 3 |
| `@types/google.maps` | 3.66.3 | 3.66.4 | 2026-09-23 | 3 |
| `@uiw/codemirror-themes` | 4.25.11 | 4.25.12 | 2026-09-24 | 3 |
| `@uiw/react-codemirror` | 4.25.11 | 4.25.12 | 2026-09-24 | 3 |
| `ai` | 7.0.107 | 7.0.114 | 2026-09-24 | 3 |
| `better-auth` | 1.7.5 | 1.7.6 | 2026-09-24 | 3 |
| `fumadocs-core` | 16.15.12 | 16.15.14 | 2026-09-24 | 3 |
| `fumadocs-mdx` | 15.4.2 | 15.4.5 | 2026-09-25 | 3 |
| `fumadocs-ui` | 16.15.12 | 16.15.14 | 2026-09-24 | 3 |
| `motion` | 13.4.0 | 13.4.4 | 2026-09-25 | 3 |
| `music-metadata` | 11.15.0 | 11.16.0 | 2026-09-22 | 5 |
| `next` | 16.3.5 | 16.3.6 | 2026-09-22 | 3 |
| `undici` | 8.10.2 | 8.11.0 | 2026-09-22 | 5 |
| `@iconify-icons/tabler` | 2.0.0 | 2.0.2 | 2026-09-23 | 3 |
| `@lezer/generator` | 1.8.0 | 1.8.1 | 2026-09-25 | 3 |
| `tsx` | 4.23.14 | 4.23.15 | 2026-09-20 | 3 |
| `vitest` | 5.0.1 | 5.0.2 | 2026-09-25 | 3 |

## Package decisions

### AI and transport

- **`ai` 7.0.107 → 7.0.114:** tool-choice/caller enforcement, cancellation of
  pending tool repairs, transformed approval validation, UI metadata preservation,
  reasoning-stream fixes, and telemetry allowlist enforcement improve Nova's
  tool loop and transcripts. `createUIMessageStream` now reports consumer
  cancellation to its end callback. Nova deliberately drains its own barrier
  stream and finalizes in `execute`'s `finally`; a browser disconnect must not
  settle billing or stop a resumable run. Keep that ownership. The new flag
  cannot replace it. Google embedding/TTS, video and experimental evaluation
  changes have no active Nova consumer.
- **`@ai-sdk/openai` 4.0.71 → 4.0.75:** adds GPT-6 model IDs, preserves null-code
  stream errors, and strips unsupported lookaround patterns before sending JSON
  schemas while retaining client validation. Nova's optional-to-null structured
  output projection still has a different job and remains necessary. The new
  message-level `reasoningEffortUpdate` preserves caching when effort changes
  during a conversation. Nova currently uses fixed semantic-role efforts and
  invalidates incompatible durable checkpoints, so no synthetic update messages
  or model-policy change are needed for this upgrade.
- **`@ai-sdk/react` 4.0.110 → 4.0.117:** follows the matching `ai` release and
  fixes overlapping/throttled `useCompletion` requests. Nova uses `Chat` and
  `useChat`, not `useCompletion`. Keep the existing `@ai-sdk/workflow` override
  to the same `ai` version so the Postgres resume transport validates the same
  chunk protocol as the server.
- **`undici` 8.10.2 → 8.11.0:** improves HTTP/2 session/ref and GOAWAY handling,
  decompression/backpressure, proxy headers/NO_PROXY, retries, cookies and data
  URL parsing. `lib/agent/openaiProvider.ts` already pairs package-native `fetch`
  with its own `Agent`; do not switch to Node's separate dispatcher contract or
  remove the reasoning timeout. Its loopback HTTP tests exercise actual headers,
  bodies and inter-chunk timeouts. Nova does not use the optional proxy, retry,
  cache or decompression interceptors.

Sources: versioned changelogs for
[`ai`](https://github.com/vercel/ai/blob/ai%407.0.114/packages/ai/CHANGELOG.md),
[`openai`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fopenai%404.0.75/packages/openai/CHANGELOG.md),
[`react`](https://github.com/vercel/ai/blob/%40ai-sdk%2Freact%404.0.117/packages/react/CHANGELOG.md),
and [Undici 8.11.0](https://github.com/nodejs/undici/releases/tag/v8.11.0).
Installed `ai/docs`, provider docs and implementation were also inspected.

### Authentication

**`better-auth`, `@better-auth/core`, `@better-auth/api-key`, `@better-auth/cimd`,
`@better-auth/mcp`, `@better-auth/oauth-provider`: 1.7.5 → 1.7.6 together.**
The core fixes logical identity when a custom model name collides with a schema
key. Nova's `auth_` names remain distinct. React hydration and overlapping-query
fixes benefit session/Project queries directly. API key, CIMD and OAuth provider
have no independent feature migration in their 1.7.6 changelogs; MCP follows the
OAuth dependency. No new auth schema is introduced. Nova keeps its shared
Kysely/Postgres adapter and canonical schema names.

Dynamic banned-user messages and BotID are opt-in product features, not
replacements for Nova's Google OAuth/allowlist flow. No password, captcha,
Cloudflare D1, SQLite or OAuth Proxy consumer needs migration. The new standalone
auth CLI schema commands do not replace Nova's programmatic migrations and
Postgres session-cookie contract.

Source: [Better Auth 1.7.6 and linked package changelogs](https://github.com/better-auth/better-auth/releases/tag/v1.7.6).

### Dragging

**Auto-scroll 3.2.0 → 3.2.1 requires core 4.0.0.** Accepting #694 alone installs
core 3.1.0 for Nova's row adapters and a private core 4.0.0 for auto-scroll's
`monitorForElements`. Each adapter owns its own monitor registry; the latter
never observes the former's drags. Core's module-local registries in
`make-adapter`/`make-monitor` establish this independently of type-checking.

Upgrade **core 3.1.0 → 4.0.0** and **Hitbox 2.2.2 → 3.0.0** together. Both majors
remove deprecated re-export shims. Nova already imports `adapter/element-adapter`,
`utils/*`, `closest-edge/attach-closest-edge`, `closest-edge/extract-closest-edge`
and `types`. No compatibility override or legacy import is necessary. Hitbox's
new dependency aligns it with core 4 as well. `npm ls` must show one deduped core.

The browser regression exercises `VirtualFormList` through the real Builder:
a native field drag enters the lower scroll region, the canvas moves, and Escape
ends the drag. Existing native drop tests cover committed ordering and cancelled
drops. A reorder-only check cannot catch a disconnected auto-scroll monitor.
The same test failed against the original #694 manifests: dragging started,
but the canvas stayed at `scrollTop: 0` for the full assertion deadline. It
passed with the deduped core 4 graph. Both runs built the production application.

Sources: published npm manifests and bundled changelogs for
[auto-scroll 3.2.1](https://www.npmjs.com/package/@atlaskit/pragmatic-drag-and-drop-auto-scroll/v/3.2.1),
[core 4.0.0](https://www.npmjs.com/package/@atlaskit/pragmatic-drag-and-drop/v/4.0.0),
and [Hitbox 3.0.0](https://www.npmjs.com/package/@atlaskit/pragmatic-drag-and-drop-hitbox/v/3.0.0).

### Framework, reporting and documentation

- **Next 16.3.5 → 16.3.6:** security fix for `next/og` ImageResponse. No Nova
  `next/og`/ImageResponse call site exists. Still adopt the patched framework;
  verify the complete deployable image and production-mode browser suite. The
  TS 7 checker arrangement, standalone packaging and deployment-skew controls
  remain necessary and unchanged.
- **Sentry 10.75.0 → 10.75.3:** fixes unhandled rejected promises when Vercel AI
  streams abort, Next tunnel matching, SDK-relative Next version resolution,
  and URL-query collection policy. These relate directly to Nova's AI calls,
  `/api/monitoring` tunnel and standalone image. Nova already imports
  `withSentryConfig` from `@sentry/nextjs/config`. Other Cloudflare/TanStack
  changes do not apply.
- **Fumadocs core/UI 16.15.12 → 16.15.14:** fixes sidebar overlap/focus, search
  combobox semantics, copy announcements/failures, TOC step preservation and
  footer wrapping. Nova uses the docs layout, search and copy components, so
  receives those behaviors directly. `pageUrl` is optional; Nova has no
  configured base path. The new block TOC style is an optional design change,
  not a migration requirement.
- **Fumadocs MDX 15.4.2 → 15.4.5:** deterministic glob ordering benefits generated
  collections. Cached frontmatter-only imports are fixed, but Nova does not
  enable `experimentalBuildCache`. Vite dependency-crawl optimizations do not
  apply to its Next compiler. Keep `includeProcessedMarkdown` for LLM routes.

Sources: [Next 16.3.6](https://github.com/vercel/next.js/releases/tag/v16.3.6),
[Sentry changelog](https://github.com/getsentry/sentry-javascript/blob/10.75.3/CHANGELOG.md),
[Fumadocs 16.15.13](https://github.com/fuma-nama/fumadocs/releases/tag/fumadocs%4016.15.13),
[16.15.14](https://github.com/fuma-nama/fumadocs/releases/tag/fumadocs%4016.15.14),
and [MDX changelog](https://github.com/fuma-nama/fumadocs/blob/fumadocs-mdx%4015.4.5/packages/mdx/CHANGELOG.md).

### Editors, maps and presentation

- **Lezer common 1.5.2 → 1.5.3:** avoids repeated mixed-tree scans. **Highlight
  1.2.3 → 1.2.4:** corrects precedence of multiple highlighting sources.
  **Generator 1.8.0 → 1.8.1:** terminates cyclic token-precedence grammars.
  Nova's XPath parser, formatter and CodeMirror binding retain their existing
  NodeType identities and grammar. No grammar API migration is introduced.
- **UIW themes and React CodeMirror 4.25.11 → 4.25.12:** fixes generated theme
  runtime dependency declarations and TypeScript build configuration. Nova's
  `createTheme` and controlled XPath editor APIs remain supported.
- **Maps loader 2.1.1 → 2.1.3:** 2.1.2 uses `google.maps.ImportLibraryMap` for
  typing; 2.1.3 adds upstream install-script policy. Nova already uses typed
  `importLibrary` calls plus singleton `setOptions`, with advanced markers.
  **Maps types 3.66.3 → 3.66.4:** adds `defaultIconHidden` to PlaceSearchLinkElement
  and removes `colorScheme` from RoutePolyline3DOptions. Neither is used by
  Nova's geopoint picker. No casts or legacy-loader compatibility layer needed.
- **Motion 13.4.0 → 13.4.4:** fixes AnimatePresence reentry, animations revealed
  by Suspense, Reorder coordinates at zero, easing handling and SVG CSS
  variables. Nova's chat and Builder transitions benefit without changing
  their intended motion. AnimateView predates this bump and is not a required
  replacement for presence/layout animations.
- **Tabler icon data 2.0.0 → 2.0.2:** 36 additional exports. Every one of Nova's
  206 directly imported icon modules resolves and has identical bytes across
  the published packages. No renamed import or changed drawing needs repair.

Sources: Lezer's primary repository changelogs for
[common](https://code.haverbeke.berlin/lezer/common/raw/commit/522b88439dc85638376b6bc835ce2eca170f0e6c/CHANGELOG.md),
[highlight](https://code.haverbeke.berlin/lezer/highlight/raw/commit/7df4d029f1c3ac4eaf7f23d4c01c832dd9fb9ce5/CHANGELOG.md),
[generator](https://code.haverbeke.berlin/lezer/generator/raw/commit/fb36fac862d045f012c45b0162c8cd826e5529c0/CHANGELOG.md),
[UIW 4.25.12](https://github.com/uiwjs/react-codemirror/releases/tag/v4.25.12),
[Maps 2.1.2](https://github.com/googlemaps/js-api-loader/releases/tag/v2.1.2),
[Maps 2.1.3](https://github.com/googlemaps/js-api-loader/releases/tag/v2.1.3),
[Motion changelog](https://github.com/motiondivision/motion/blob/v13.4.4/CHANGELOG.md),
and the published [Maps types](https://www.npmjs.com/package/@types/google.maps/v/3.66.4)
and [Tabler](https://www.npmjs.com/package/@iconify-icons/tabler/v/2.0.2) tarballs.

### Media and development tools

- **music-metadata 11.15.0 → 11.16.0:** bounds MP4, APEv2, EBML and ID3 allocations
  and fixes malformed MP4 sample/header handling. This matters for untrusted
  uploads passing through `lib/media/validate.ts`. Nova uses `parseBuffer` with
  byte size and skips cover art; duration remains optional for valid video-only
  containers. New lyrics/rating/date mappings are not consumed. Keep existing
  byte sniffing, upload limits and deadline; parser hardening complements them.
- **tsx 4.23.14 → 4.23.15:** fixes builtin namespace inheritance, CommonJS
  `require.cache`/`extensions` through `tsImport`, and register declaration
  portability. Nova runs the CLI with `--conditions=react-server` where needed;
  no custom loader migration is indicated.
- **Vitest 5.0.1 → 5.0.2:** fixes asymmetric `toMatchObject`, process binding,
  concurrent reporters, spy recursion and ESM hanging-process diagnostics.
  jsdom/UI and async-leak detector changes do not apply to Nova's current
  happy-dom/Node projects. Retain promise ownership, React act checks and one
  suite execution per CI shard; do not restore the retired leak sweep.

Sources: [music-metadata 11.16.0](https://github.com/Borewit/music-metadata/releases/tag/v11.16.0),
[tsx 4.23.15](https://github.com/privatenumber/tsx/releases/tag/v4.23.15),
and [Vitest 5.0.2](https://github.com/vitest-dev/vitest/releases/tag/v5.0.2).

## Verification boundary

Use the exact Node 24.21.0/npm 12.0.2 toolchain and strict install-script policy.
The installation reports zero known npm audit vulnerabilities. Local checks
cover types, the unit suite, real auth/chat Postgres contracts and native dragging.
The shipping PR must pass the complete CI matrix, including the deployable image,
all six test shards, browser/app smoke lanes, auth probes and CodeQL.
No paid `test:schema` request, production data migration or live model quality
claim is part of this dependency update.
