# Dependabot #700 audit

Reviewed against Nova main after #699, using the published packages, upstream
release notes and Nova's actual consumers. This batch has seven direct updates
and four transitive updates. No extra major or override is needed.

## Release age

The npm registry publication times below were checked on September 29, 2026,
after 23:24 UTC. Every patch clears three full days; every minor clears five.
The youngest patch is OpenAI 4.0.78 (more than 3.89 days); MCP 2.1 is more than
6.32 days old. Node 24.21.0 satisfies every changed package's engine constraint.

| Package | Upgrade | Published UTC |
| --- | --- | --- |
| `@ai-sdk/openai` | 4.0.75 → 4.0.78 | Sep 26 02:01:30 |
| `@ai-sdk/react` | 4.0.117 → 4.0.119 | Sep 25 20:39:13 |
| `ai` | 7.0.114 → 7.0.116 | Sep 25 20:41:56 |
| `@modelcontextprotocol/server` | 2.0.0 → 2.1.0 | Sep 23 15:45:32 |
| `@modelcontextprotocol/client` | 2.0.0 → 2.1.0 | Sep 23 15:45:32 |
| `music-metadata` | 11.16.0 → 11.16.1 | Sep 24 16:00:18 |
| `undici` | 8.11.0 → 8.11.2 | Sep 24 08:37:55 |
| `@ai-sdk/provider-utils` (transitive) | 5.0.47 → 5.0.49 | Sep 25 20:39:53 |
| `@ai-sdk/gateway` (transitive) | 4.0.92 → 4.0.94 | Sep 25 20:44:06 |
| `@ai-sdk/mcp` (transitive) | 2.0.58 → 2.0.60 | Sep 25 20:40:49 |
| `@modelcontextprotocol/core` (transitive) | 2.0.0 → 2.1.0 | Sep 23 15:44:30 |

Evidence: each package's `https://registry.npmjs.org/<package>` `time[version]`,
compared with `.github/dependabot.yml`. The lockfile adds no new package or install
script. `npm ci` under Nova's strict script policy reports zero known vulnerabilities.

## Decisions by package

**OpenAI.** [4.0.78 changelog](https://github.com/vercel/ai/blob/%40ai-sdk%2Fopenai%404.0.78/packages/openai/CHANGELOG.md)
adds `none` to supported Sol/Luna effort updates and validates model-specific
updates. Nova selects fixed role efforts in `lib/models.ts`, with stateless
requests and compaction; it does not change effort midway through a history.
There is no reason to enable this different reasoning mode for a dependency bump.
The preceding patch defaults Responses function tools to non-strict mode.
Nova already declares `strict: false` intentionally to preserve omitted arguments;
retain that explicit cross-provider contract. Structured responses still need
Nova's optional-to-null projection; the function-tool default does not replace it.

**AI core and React.** [7.0.116 changelog](https://github.com/vercel/ai/blob/ai%407.0.116/packages/ai/CHANGELOG.md)
and the installed React changelog show the hook update follows core/provider-utils.
Core adopts ES2022 output, isolates credentials on untrusted download origins,
and preserves opaque file URIs with exact MIME matching. Nova's Node/browser
baseline supports ES2022. `resolveAttachments.ts` and `documentExtraction.ts`
provide authorized media as inline data URIs, not authenticated remote downloads.
No URL shim or custom download hook is needed. Existing streaming, reconnect,
wire-schema and extraction tests exercise the retained interfaces.

Provider-utils 5.0.48–49 implements those download/URI changes. Gateway 4.0.93–94
also adds Browserbase tools and structured-output routing; Nova constructs the
OpenAI provider directly and has no gateway consumer. The transitive AI MCP client
2.0.59–60 adopts isolated OAuth discovery fetching; Nova's server uses the official
MCP SDK instead. Keep the existing Workflow transport override pointing at Nova's
`ai`; this batch supplies no replacement for its Postgres reconnect contract.

**MCP server.** [2.1.0 release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol%2Fserver%402.1.0)
adds per-operation scope challenges, bounded HTTP reads, stricter modern headers,
and cancellation/error fixes. Adopt the new reader before Nova's existing JSON
pre-parse: otherwise `parsedBody` bypasses the SDK bound. Allow base64 for Nova's
largest admitted asset plus 1 MiB framing; cancel rejected streams. Configure the
same bound on fallback parsing. Retain native parse and protocol validation.

Register scope challenges on every HQ/Projects protected tool. Pass independently
verified OAuth authentication to the SDK, preserve existing grants in incremental
consent, and include Nova's resource metadata URL. Static API keys keep settings
remediation. Existing handler guards still protect non-HTTP calls. Modern clients
must send the protocol header; tests cover that refusal and both protocol eras.
Nova does not serve stdio or task primitives, so those fixes need no adapter.

**MCP client and core.** [2.1.0 client release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol%2Fclient%402.1.0)
adds optional DPoP, corrects managed-header precedence and exact resource indicators,
surfaces token-save failures and network `Error.cause`, and fixes cancellation,
Windows stdio environment and task headers. Nova uses this dev dependency for
real in-memory SDK test peers, not an outbound production OAuth client. There is
no token store or deprecated `error.data.cause` consumer to migrate. Core is one
deduped 2.1.0 supporting both endpoints; tests exercise their actual wire schemas.

**Music metadata.** [11.16.1 release](https://github.com/Borewit/music-metadata/releases/tag/v11.16.1)
replaces regex trimming of ID3 TXXX NUL padding and repairs Ogg picture comments
spanning pages. Nova parses uploaded MP3/WAV/MP4 bytes for integrity and duration,
skips covers, and excludes Ogg at its media boundary. Accept the parser fixes;
no new format or API change is warranted. Existing real-media fixtures remain
its appropriate validation boundary.

**Undici.** [8.11.1](https://github.com/nodejs/undici/releases/tag/v8.11.1)
reverts HTTP/2 preservation in the legacy bridge and fixes large redirect bodies
and WebSocket streams. [8.11.2](https://github.com/nodejs/undici/releases/tag/v8.11.2)
closes rejected HTTP/2 WebSocket handshakes and avoids reconnecting aborted
requests. Nova uses package-native `fetch` and `Agent` together, scoped to OpenAI,
not the legacy native-fetch bridge or WebSockets. Retain that supported transport;
its real HTTP peer tests cover response streaming, cancellation and timeout policy.

## Verification contract

The new native HTTP tests cover all twelve protected tool registrations, OAuth
credential propagation, preserved grants and metadata, API-key remediation,
modern protocol-header validation, maximum media framing, and declared/chunked
oversize rejection with stream cancellation. Existing Postgres endpoint/tool
tests retain identity, consent and authorization proof. The full unit suite,
focused Postgres tests, lint/typecheck, production build/browser CI and independent
frozen-commit review gate release. No paid model-schema probes are needed.
