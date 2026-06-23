# CommCare Nova

Nova turns a natural-language conversation into a working CommCare app. A user describes the data they collect and the workflow they run; a single AI agent — the **Solutions Architect** (SA) — designs the app (modules, forms, fields, case management, logic) through tool calls. The user then refines it by chatting or by editing directly in a visual builder, previews it live against real case data, and exports it to a device or uploads it to CommCare HQ. The same tools are also reachable by external clients over an MCP API.

> CommCare is Dimagi's platform for frontline data collection (forms + case management), and its wire format is the only thing Nova inherits. **Nova is not a CommCare HQ clone** — its authoring model is original and deliberately simpler. "HQ does it this way" is never a design argument here; the only admissible HQ facts are "the wire accepts / rejects this."

This file is a map: the mental models, then where everything lives, then the few repo-wide rules with no subtree home. Each area's depth lives in its own `CLAUDE.md` — follow the pointers rather than expecting the detail here.

## The mental models that explain everything

1. **One document, three editors, everything derived.** An app *is* a `BlueprintDoc` (`lib/domain`). The chat SA, the visual builder, and the MCP API all edit that one doc by emitting the same fine-grained mutations; the live preview, the exported CommCare artifacts, and the Postgres case schema are all *derived* from it, never stored beside it.
2. **Valid by construction.** An invalid app can't exist. Every mutation batch is gated *before* it commits and rejected if it would introduce a validator finding — identically on all three editors. There is no save/validate/release cycle and no draft state; creation is atomic so growth never dead-ends, and exports re-run the full validator with zero tolerance. (`lib/doc`, `lib/agent`.)
3. **Domain in, CommCare wire out.** Nova speaks its own clean vocabulary; CommCare's wire vocabulary is quarantined behind `lib/commcare`, a one-way emission boundary enforced by a Biome import rule. The SA and the builder never speak CommCare.
4. **References are identity; text is a projection.** Every XPath slot stores a typed AST whose references are UUIDs or `(caseType, property)` pairs, not strings — so renames and moves never rewrite expressions; printing resolves identity to the current name. Never regex-parse XPath. (`lib/domain`, `lib/commcare/xpath`.)
5. **The preview is the real app on real data.** There is no mock preview mode: the builder's running-app view executes the blueprint in a client-side engine (`lib/preview`) over the user's actual Postgres case rows (`lib/case-store`). "Sample data" writes real rows.

## The map — where everything lives

The two centers of gravity are the **domain vocabulary** and the **doc that instantiates it**; everything else edits the doc, derives something from it, or supports a surface that does.

- **`lib/domain`** — the blueprint vocabulary every surface speaks: fields (self-contained; two identities — `uuid` for UI, `id`/path for mutations), the case-type catalog, the XPath + Predicate ASTs, the media primitives. The Zod schemas are the reference; its `CLAUDE.md` holds the rules they can't state.
- **`lib/doc`** — the normalized, undoable doc store, the `Mutation` reducer, the commit gate, the reference index, and the text⇄AST bridge. Private; reach it through `lib/doc/hooks`.
- **`lib/agent`** — the one SA `ToolLoopAgent` and everything Claude-facing: prompts, the tool surface, structured-output schema generation, and the `/api/chat` build/edit flow (plan, then atomic create, gated, drained server-side). Treat its prompts / schemas / model as load-bearing infrastructure — they are coupled to prompt-caching and grammar-constrained decoding. The MCP server (`lib/mcp`, `app/api/mcp`) exposes the same shared tools with no agent loop.
- **`lib/commcare`** — `BlueprintDoc` → wire (XForm XML, HQ JSON, suite.xml, `.ccz`), the validator and its parse-time oracles, the XPath dialect + transpiler (`lib/commcare/xpath`), the HQ REST client, and KMS credential encryption. This is the compile / export / HQ-upload path; the barrel is client-safe and consumers are allowlisted in `biome.json`.
- **`lib/case-store`** — Cloud SQL Postgres holding the user's real case data, tenant-scoped by `(app_id, owner_id)`; the only evaluator is the AST→Kysely compiler (`lib/case-store/sql`). Schema + indexes are materialized from the blueprint; Atlas owns migrations.
- **`lib/media`** — asset validation, the attach- and export-time verdicts, the export budget, the wire manifest, and the deletion guard. Bytes live in GCS (`lib/storage`), a status row in Firestore (`lib/db/mediaAssets`).
- **The builder UI** — `components/builder` (the canvas, flipbook, inspector rail, case-list workspace, media pickers; its doc opens with the three-sources-of-truth state model) draws on `lib/routing` (URL-driven location / selection via the History API), `lib/session` (ephemeral run / UI state), `lib/preview` (the client-side form engine), `lib/codemirror` (the XPath editor), and `lib/ui` (cross-cutting hooks + the toast / keyboard singletons). Repo-wide React conventions — icons, inputs, floating elements, theme — live in `components/CLAUDE.md`.
- **`lib/db`** — the Firestore client, the app / thread / run / credit / usage schemas, the two-ledger credit gate, and the fail-closed run-finalization invariants. `lib/log` is the per-run event stream that powers replay and admin inspect.
- **Auth + hosting** — `lib/auth` (Better Auth: Google OAuth for users, OAuth + API-key bearers for MCP, the sign-in email allowlist), `lib/hostnames` + `proxy.ts` (per-host routing), and `app/` (the route groups; root `app/layout.tsx` reads no session so public surfaces don't pay for auth).

## Repo-wide rules (no subtree home)

- **Multi-host routing.** One Cloud Run service serves three hostnames, split by `proxy.ts` on the `Host` header, with per-host allowlists in `lib/hostnames.ts`. **A new `/api/*` route needs an allowlist entry or the proxy 404s it in prod while localhost masks it** — the single most common deploy-time surprise.
- **Deploy.** Merge to main auto-deploys to Cloud Run (us-central1); the default `*.run.app` URL is disabled. Schema migrations run as a separate Cloud Run Job per deploy, blocking the deploy on failure (mechanics in `lib/case-store`).
- **Observability is two-channel.** Cloud Logging is the structured-JSON stream (`lib/logger.ts`); Sentry owns grouping / replay. `log.error` / `log.critical` mirror to Sentry; `log.warn` stays Cloud-Logging-only. Browser errors tunnel through `/api/monitoring`.
- **Tests must not leak async resources.** CI runs `--detect-async-leaks` over the tests a PR touched — `vitest --changed` against the merge base, which is sound because the detector pins each leak to the one test file that created it (no cross-file leak), so a change to shared infra (config / setup / deps) re-sweeps everything via `forceRerunTriggers`. It fails on any leak (`npm run test:leaks` reproduces the full sweep locally). Fix at the source — clear timers in `afterEach`, await or cancel promises, let RTL auto-cleanup unmount; prefer testing state + pure transformations over mounting UI.
- **Migrations are scan-then-migrate.** A one-off data migration ships as a read-only scan script plus a separate migrate script in `scripts/`; run them when deploying over old data.
- **Docs move with behavior.** When a change alters what users see or do, update the public docs under `app/(docs)/`, and keep the nearest subtree `CLAUDE.md` honest — it is injected at the top of every session working in that area.

## Stack & commands

Next.js 16 (App Router, Turbopack) · TypeScript strict · Tailwind v4. Vercel AI SDK (v7 beta) + Anthropic Claude. Better Auth. Firestore (app state) · Cloud SQL Postgres via Kysely + Atlas (case data) · Cloud KMS · GCS (media). Zustand (+ zundo) for builder state. Biome + Lefthook · Vitest.

```bash
npm run dev          # boots local case-store Postgres (compose.yaml) + migrations, then Turbopack
npm run build / lint / format / test
npm run test:leaks   # full suite under the async-leak detector (CI scopes it to PR-changed tests via --changed)
npm run test:smoke   # Playwright UI smoke (Firestore emulator + local Postgres + seeded session) — see e2e/CLAUDE.md
npm run typecheck    # fumadocs-mdx + tsc --noEmit
npm run db:diff / db:lint        # author / lint a case-store migration (Atlas)
npx tsx scripts/test-schema.ts   # verify SA tool-input schemas are API-accepted
```

`npm run dev` needs Docker (it boots the case-store Postgres); the app reaches it via `NOVA_DB_LOCAL_URL` in `.env` (an explicit opt-in — prod uses the Cloud SQL connector). `scripts/` also has read-only Firestore inspectors and a `recover-app` writer (⚠️); run any with `--help`.
