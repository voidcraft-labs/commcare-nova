# Phase C — MCP endpoint skeleton

**Goal:** Build the per-request machinery every MCP tool adapter will share: a source-tagged event log with a backfill migration, an MCP-variant context that implements the shared `ToolExecutionContext` interface (defined in Phase D), a progress emitter, an ownership helper, an OAuth-aware scope helper that delegates to the plugin's `verifyAccessToken`, and a classified-error serializer.

**No rate-limiting module.** MCP tool calls are authenticated-only and match the existing Nova convention — no app-level limits. Better Auth's rate limiting on `/api/auth/*` covers the auth plane via the oauth-provider plugin defaults (verified in Phase B).

**No concurrency / `hasActiveGeneration` / status-flip guards.** Those are chat-specific (LLM cost protection + web UI state sync). HTTP tool calls are sequential from a single client; subagent tool turns are serial; existing mutation helpers surface proper errors for out-of-order operations.

**Dependencies:** Phase B (OAuth plugin installed). Phase D will reference Phase C's `McpContext` + types; Phase C defines the context shape but the `ToolExecutionContext` interface itself is introduced in Phase D alongside the SA-side implementation.

---

## Task C1: Event-source tagging + historical backfill migration

Every event written by the MCP path needs `source: "mcp"` so analytics can distinguish surfaces. The spec requires this as a hard field; we backfill historical events with a one-shot migration script rather than carrying a back-compat default forever.

**Files:**
- Modify: `lib/log/types.ts`
- Modify: `lib/log/writer.ts`
- Modify: `lib/agent/generationContext.ts`
- Modify: `app/api/chat/route.ts`
- Modify: any existing test fixture that constructs `new LogWriter(...)` or hand-builds event envelopes.
- Create: `scripts/migrate-event-source.ts`

- [ ] **Step 1: Add required `source` field to the envelope schema**

Edit `lib/log/types.ts`. Locate `envelopeSchema` and add the field (no optional, no default — present on every envelope):

```ts
const envelopeSchema = z.object({
	runId: z.string(),
	ts: z.number(),
	seq: z.number(),
	/**
	 * Which entrypoint produced this event. "chat" = web chat route
	 * (/api/chat, SSE + session cookie); "mcp" = MCP endpoint
	 * (/mcp, HTTP JSON-RPC + OAuth bearer). Required on every
	 * envelope; historical events backfilled via
	 * scripts/migrate-event-source.ts.
	 */
	source: z.enum(["chat", "mcp"]),
});
```

- [ ] **Step 2: Plumb `source` through `LogWriter`**

Edit `lib/log/writer.ts`:

```ts
export class LogWriter {
	// ...existing fields...
	private readonly source: "chat" | "mcp";

	constructor(appId: string, source: "chat" | "mcp") {
		this.appId = appId;
		this.source = source;
		// ...existing init...
	}

	logEvent(event: MutationEvent | ConversationEvent): void {
		/* Stamp the source tag on every envelope. Call sites never set
		 * this directly — the writer owns it so "which surface"
		 * cannot drift from the writer's construction context. */
		const stamped = { ...event, source: this.source };
		// ...existing batching / persist logic, now writing `stamped`...
	}
}
```

- [ ] **Step 3: Update chat route + GenerationContext + tests**

```bash
grep -rn "new LogWriter(" lib/ app/ components/ --include="*.ts" --include="*.tsx"
```

Every call site gets `"chat"` as the second arg (they all pre-date MCP). Fix each.

- [ ] **Step 4: Write the backfill migration script**

Create `scripts/migrate-event-source.ts`:

```ts
/**
 * Backfill `source: "chat"` onto historical event envelopes.
 *
 * Every event written before this deploy lacks a `source` field. The
 * schema now requires it. Run this script once against production
 * Firestore before deploying the app version that enforces the new
 * schema on reads.
 *
 * Strategy: batch-scan `apps/{appId}/events/` across every app, update
 * docs that lack a `source` field with `source: "chat"` (every
 * pre-MCP event came from the chat surface). Idempotent — re-running
 * only touches docs still missing the field.
 *
 * Usage: npx tsx scripts/migrate-event-source.ts [--dry-run]
 */

import { getDb } from "@/lib/db/firestore";
import { log } from "@/lib/logger";

async function run(dryRun: boolean) {
	const db = getDb();
	const apps = await db.collection("apps").select().get();
	let scanned = 0;
	let updated = 0;

	for (const app of apps.docs) {
		const events = await app.ref.collection("events").get();
		let batch = db.batch();
		let batchSize = 0;
		for (const ev of events.docs) {
			scanned++;
			if (ev.data().source !== undefined) continue;
			if (!dryRun) {
				batch.update(ev.ref, { source: "chat" });
				batchSize++;
			}
			updated++;
			/* Firestore batch cap is 500 writes; flush at 400 to leave
			 * headroom for any nested-update quirks. */
			if (batchSize >= 400) {
				await batch.commit();
				batch = db.batch();
				batchSize = 0;
			}
		}
		if (batchSize > 0) await batch.commit();
	}

	log.info(
		`[migrate-event-source] scanned=${scanned} updated=${updated} dryRun=${dryRun}`,
	);
}

const dry = process.argv.includes("--dry-run");
run(dry).catch((e) => {
	console.error(e);
	process.exit(1);
});
```

- [ ] **Step 5: Dry-run + full run**

```bash
npx tsx scripts/migrate-event-source.ts --dry-run
# review output; scanned should be every event; updated should be every event missing source
npx tsx scripts/migrate-event-source.ts
```

This MUST run before the app deploys with the new schema enforced — otherwise reads of historical events break.

- [ ] **Step 6: Run full suite + type-check**

```bash
npx vitest run
npx tsc --noEmit && echo "✓"
```

- [ ] **Step 7: Commit**

```bash
git add lib/log/types.ts lib/log/writer.ts lib/agent/generationContext.ts app/api/chat/route.ts lib/log/__tests__ scripts/migrate-event-source.ts
git commit -m "feat(log): require source (chat|mcp) on every event envelope + backfill migration"
```

---

## Task C2: Shared MCP types module

**Files:**
- Create: `lib/mcp/types.ts`

- [ ] **Step 1: Write `lib/mcp/types.ts`**

```ts
/**
 * Shared MCP types.
 *
 * Single source of truth for request-scoped types that flow from the MCP
 * route handler into every tool adapter. Kept in a separate module so
 * adapter files can import without creating a cycle with lib/mcp/server.ts
 * (which depends on them).
 */

/**
 * Per-request context the MCP route handler materializes from the verified
 * JWT claims. Passed to each adapter's `register<Tool>(server, ctx)` call
 * so adapter closures can resolve the authenticated user without
 * re-parsing the token. Scopes are already checked at the verify layer
 * via the plugin's `verifyAccessToken({ scopes })` — this context carries
 * them for informational use only.
 */
export interface ToolContext {
	/** Better Auth user id, from the JWT `sub` claim. */
	userId: string;
	/** Scopes granted on this token, post-verification. */
	scopes: readonly string[];
}

/**
 * JWT claim shape the route handler receives post-verification.
 */
export interface JwtClaims {
	sub: string;
	scope?: string;
	aud?: string | string[];
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/mcp/types.ts
git commit -m "feat(mcp): shared ToolContext + JwtClaims types"
```

---

## Task C3: `McpContext`

`McpContext` mirrors `GenerationContext` for the MCP surface. In Phase D, both will be declared to implement a narrow `ToolExecutionContext` interface — for now, write `McpContext` with the method set we know we need; Phase D's interface declaration lands in the same file as the interface.

**Files:**
- Create: `lib/mcp/context.ts`
- Create: `lib/mcp/__tests__/context.test.ts`

- [ ] **Step 1: Write `lib/mcp/context.ts`**

```ts
/**
 * McpContext — request-scoped glue for MCP tool adapters.
 *
 * Mirrors lib/agent/generationContext.ts for the MCP path: owns the event
 * log writer and progress emitter so tool adapters can persist mutations
 * + conversation events and announce progress through a single API.
 *
 * Diverges from GenerationContext in three ways:
 *   - No Anthropic client. The MCP server does not reason; the client does.
 *   - No UsageAccumulator. There are no LLM tokens to bill on this surface.
 *   - Progress goes out as MCP `notifications/progress` events, not SSE.
 *
 * Lifecycle: one McpContext per tool call. `runId` is threaded from the
 * client via `_meta.run_id` on the tool call so a multi-call build / edit
 * shows up as one coherent run in the admin run-summary surface. If the
 * client omits it, a fresh runId is minted per call (isolated read).
 *
 * recordMutations awaits the Firestore save before returning so the tool
 * cannot return before the write lands — preserves the fail-closed
 * persistence guarantee we have on the chat surface.
 */

import { updateApp } from "@/lib/db/apps";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type {
	ConversationEvent,
	ConversationPayload,
	MutationEvent,
} from "@/lib/log/types";
import type { LogWriter } from "@/lib/log/writer";
import type { ProgressEmitter } from "./progress";

export interface McpContextOptions {
	appId: string;
	userId: string;
	runId: string;
	logWriter: LogWriter;
	progress: ProgressEmitter;
}

export class McpContext {
	readonly appId: string;
	readonly userId: string;
	readonly runId: string;
	readonly logWriter: LogWriter;
	readonly progress: ProgressEmitter;
	private seq = 0;

	constructor(opts: McpContextOptions) {
		this.appId = opts.appId;
		this.userId = opts.userId;
		this.runId = opts.runId;
		this.logWriter = opts.logWriter;
		this.progress = opts.progress;
	}

	async recordMutations(
		mutations: Mutation[],
		doc: BlueprintDoc,
		stage?: string,
	): Promise<MutationEvent[]> {
		if (mutations.length === 0) return [];
		const events: MutationEvent[] = mutations.map((mutation) => ({
			kind: "mutation",
			runId: this.runId,
			ts: Date.now(),
			seq: this.seq++,
			actor: "agent",
			source: "mcp",
			...(stage && { stage }),
			mutation,
		}));
		for (const e of events) this.logWriter.logEvent(e);
		await this.saveBlueprint(doc);
		return events;
	}

	recordConversation(payload: ConversationPayload): ConversationEvent {
		const event: ConversationEvent = {
			kind: "conversation",
			runId: this.runId,
			ts: Date.now(),
			seq: this.seq++,
			source: "mcp",
			payload,
		};
		this.logWriter.logEvent(event);
		return event;
	}

	private async saveBlueprint(doc: BlueprintDoc): Promise<void> {
		const { fieldParent, ...persistable } = doc;
		void fieldParent;
		await updateApp(this.appId, persistable);
	}
}
```

- [ ] **Step 2: Write `lib/mcp/__tests__/context.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import type { Mutation } from "@/lib/doc/types";
import { McpContext } from "../context";

vi.mock("@/lib/db/apps", () => ({
	updateApp: vi.fn().mockResolvedValue(undefined),
}));

function mockLogWriter() {
	return {
		logEvent: vi.fn(),
		flush: vi.fn(),
	} as unknown as import("@/lib/log/writer").LogWriter;
}

function mockProgress() {
	return { notify: vi.fn() };
}

function mockDoc(): BlueprintDoc {
	return {
		appId: "a",
		appName: "",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

describe("McpContext", () => {
	it("writes one log event per mutation, advances seq, stamps source=mcp", async () => {
		const logWriter = mockLogWriter();
		const ctx = new McpContext({
			appId: "a",
			userId: "u",
			runId: "r",
			logWriter,
			progress: mockProgress(),
		});
		const muts: Mutation[] = [
			{ type: "setAppName", name: "x" } as Mutation,
			{ type: "setAppName", name: "y" } as Mutation,
		];
		const events = await ctx.recordMutations(muts, mockDoc(), "scaffold");
		expect(events).toHaveLength(2);
		expect(events[0].seq).toBe(0);
		expect(events[1].seq).toBe(1);
		expect(events.every((e) => e.source === "mcp")).toBe(true);
		expect(events.every((e) => e.stage === "scaffold")).toBe(true);
		expect(
			(logWriter.logEvent as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(2);
	});

	it("awaits updateApp before resolving", async () => {
		const { updateApp } = await import("@/lib/db/apps");
		let resolveSave: () => void = () => {};
		(updateApp as ReturnType<typeof vi.fn>).mockImplementationOnce(
			() => new Promise<void>((r) => { resolveSave = r; }),
		);
		const ctx = new McpContext({
			appId: "a",
			userId: "u",
			runId: "r",
			logWriter: mockLogWriter(),
			progress: mockProgress(),
		});
		let settled = false;
		const p = ctx
			.recordMutations([{ type: "setAppName", name: "x" } as Mutation], mockDoc())
			.then(() => {
				settled = true;
			});
		await Promise.resolve();
		expect(settled).toBe(false);
		resolveSave();
		await p;
		expect(settled).toBe(true);
	});

	it("no-ops on empty mutation batch", async () => {
		const logWriter = mockLogWriter();
		const ctx = new McpContext({
			appId: "a",
			userId: "u",
			runId: "r",
			logWriter,
			progress: mockProgress(),
		});
		expect(await ctx.recordMutations([], mockDoc())).toEqual([]);
		expect(
			(logWriter.logEvent as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(0);
	});
});
```

- [ ] **Step 3: Run + type-check + commit**

```bash
npx vitest run lib/mcp/__tests__/context.test.ts
npx tsc --noEmit && echo "✓"
git add lib/mcp/context.ts lib/mcp/__tests__/context.test.ts
git commit -m "feat(mcp): McpContext with awaited Firestore save + source-tagged events"
```

---

## Task C4: Progress emitter

**Files:**
- Create: `lib/mcp/progress.ts`

- [ ] **Step 1: Write `lib/mcp/progress.ts`**

```ts
/**
 * MCP progress notifications.
 *
 * The `stage` taxonomy piggybacks on the existing replayChapters vocabulary
 * so UIs that consume those tags (admin-side replay, anyone building
 * against the event log) can share parsing.
 *
 * When the client didn't opt in to progress (no `_meta.progressToken` on
 * the call), notify() is a no-op so adapters can uniformly emit without
 * branching.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ProgressStage =
	| "app_created"
	| "schema_generated"
	| "scaffold_generated"
	| "module_added"
	| "form_added"
	| "validation_started"
	| "validation_fix_applied"
	| "validation_passed"
	| "upload_started"
	| "upload_complete";

export interface ProgressEmitter {
	notify(
		stage: ProgressStage,
		message: string,
		extra?: Record<string, unknown>,
	): void;
}

export function createProgressEmitter(
	server: McpServer,
	progressToken: string | number | undefined,
): ProgressEmitter {
	return {
		notify(stage, message, extra) {
			if (progressToken === undefined) return;
			server.server.notification({
				method: "notifications/progress",
				params: {
					progressToken,
					message,
					_meta: { stage, ...extra },
				},
			});
		},
	};
}
```

If the MCP SDK's `McpServer` exposes the underlying notification sender at a different path than `server.server.notification`, adjust per the current SDK shape (check context7 when wiring this up).

- [ ] **Step 2: Commit**

```bash
git add lib/mcp/progress.ts
git commit -m "feat(mcp): progress emitter with chapter-aligned stage taxonomy"
```

---

## Task C5: Ownership + scopes + errors

Three small modules, one commit. No concurrency helper — chat-specific. No rate-limit module — we inherit the existing Nova convention.

**Files:**
- Create: `lib/mcp/ownership.ts`
- Create: `lib/mcp/scopes.ts`
- Create: `lib/mcp/errors.ts`

- [ ] **Step 1: Write `lib/mcp/ownership.ts`**

```ts
/**
 * Per-request ownership check.
 *
 * Every adapter that takes an app_id runs this before invoking the
 * shared tool's execute. No concurrency guard — MCP tool calls are
 * sequential from a single client, existing mutation helpers surface
 * proper errors for out-of-order operations.
 */

import { loadAppOwner } from "@/lib/db/apps";

export class McpForbiddenError extends Error {
	constructor(public readonly reason: "not_found" | "not_owner") {
		super(reason);
		this.name = "McpForbiddenError";
	}
}

export async function requireOwnedApp(
	userId: string,
	appId: string,
): Promise<void> {
	const owner = await loadAppOwner(appId);
	if (!owner) throw new McpForbiddenError("not_found");
	if (owner !== userId) throw new McpForbiddenError("not_owner");
}
```

- [ ] **Step 2: Write `lib/mcp/scopes.ts`**

```ts
/**
 * OAuth scope constants + claim parsing.
 *
 * Scope enforcement happens at the verify layer via the oauth-provider
 * plugin's `verifyAccessToken({ scopes })` — the MCP route handler
 * (Phase G) declares required scopes per tool-mount; a bearer missing
 * the required scope is rejected before any adapter runs. This module
 * only exports constants + claim parsing.
 *
 * nova.read covers reads + agent-prompt fetch. nova.write covers every
 * mutation, including create/delete/upload. Both are granted to the
 * Nova plugin's DCR registration by default; narrower future clients
 * can request only nova.read.
 */

import type { JwtClaims } from "./types";

export const SCOPES = {
	read: "nova.read",
	write: "nova.write",
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/** Parse the JWT's space-separated scope claim into an array. */
export function parseScopes(jwt: JwtClaims): string[] {
	return (jwt.scope ?? "").split(/\s+/).filter(Boolean);
}
```

- [ ] **Step 3: Write `lib/mcp/errors.ts`**

```ts
/**
 * Classify + serialize adapter errors to the MCP-shaped tool-result.
 *
 * MCP tool errors are a successful JSON-RPC response with `isError: true`
 * on the result. Nova's existing classifier produces the taxonomy; this
 * module bridges the two.
 */

import { classifyError } from "@/lib/agent/errorClassifier";
import { McpForbiddenError } from "./ownership";

export interface McpToolErrorResult {
	isError: true;
	content: [{ type: "text"; text: string }];
	_meta: {
		error_type: string;
		app_id?: string;
	};
}

export function toMcpErrorResult(
	err: unknown,
	ctx?: { appId?: string },
): McpToolErrorResult {
	const base = ctx?.appId ? { app_id: ctx.appId } : {};

	if (err instanceof McpForbiddenError) {
		return {
			isError: true,
			content: [{ type: "text", text: `Forbidden: ${err.reason}` }],
			_meta: { error_type: err.reason, ...base },
		};
	}
	const classified = classifyError(err);
	return {
		isError: true,
		content: [{ type: "text", text: classified.message }],
		_meta: { error_type: classified.type, ...base },
	};
}
```

- [ ] **Step 4: Commit**

```bash
git add lib/mcp/ownership.ts lib/mcp/scopes.ts lib/mcp/errors.ts
git commit -m "feat(mcp): ownership + scope constants + error serializer"
```

---

## Canonical tool-adapter template (read before Phase E)

Every MCP tool adapter in `lib/mcp/tools/<name>.ts` (for MCP-only tools) or `lib/mcp/adapters/sharedToolAdapter.ts` (for wrappers over shared `lib/agent/tools/<name>.ts` modules, introduced in Phase D) follows this shape.

```ts
/**
 * nova.<tool_name> — <one-line purpose>.
 *
 * Scope: <nova.read | nova.write>. Scope enforcement happens at the
 * verify layer (Phase G route handler declares the scope per tool);
 * this handler trusts the token by the time it runs.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LogWriter } from "@/lib/log/writer";
import { loadApp } from "@/lib/db/apps";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { McpContext } from "../context";
import { toMcpErrorResult } from "../errors";
import { requireOwnedApp } from "../ownership";
import { createProgressEmitter } from "../progress";
import type { ToolContext } from "../types";

export function register<Tool>(server: McpServer, ctx: ToolContext): void {
	server.tool(
		"<tool_name>",
		"<human-readable description for the LLM>",
		/* Third arg is a Zod RAW SHAPE (not JSON Schema). Keys are
		 * field names; values are Zod types. mcp-handler composes this
		 * into a full object validator internally. */
		{
			app_id: z.string(),
			/* ... other fields ... */
		},
		async (
			args: { app_id: string /* ... */ },
			extra: { _meta?: { progressToken?: string | number; run_id?: string } },
		) => {
			try {
				/* 1. Ownership. */
				await requireOwnedApp(ctx.userId, args.app_id);

				/* 2. Per-call plumbing.
				 *    - runId: from client _meta.run_id if passed, else fresh.
				 *      Plugin skills mint one up front per subagent invocation
				 *      so a multi-call build groups coherently under one
				 *      run_id in the admin run-summary surface.
				 *    - LogWriter: constructed per call with source="mcp".
				 *    - Progress emitter: no-op if client didn't pass a token. */
				const runId = extra._meta?.run_id ?? crypto.randomUUID();
				const logWriter = new LogWriter(args.app_id, "mcp");
				const progress = createProgressEmitter(server, extra._meta?.progressToken);
				const mcpCtx = new McpContext({
					appId: args.app_id,
					userId: ctx.userId,
					runId,
					logWriter,
					progress,
				});

				try {
					/* 3. Load current blueprint. Adapter owns load; shared
					 *    tool's execute is pure domain logic. */
					const app = await loadApp(args.app_id);
					if (!app) throw new Error("not_found");
					const doc = { ...app, fieldParent: {} };
					rebuildFieldParent(doc);

					/* 4. Call the shared tool's execute (or the MCP-only
					 *    handler body). It returns { mutations, summary }
					 *    for mutating tools, or a summary string for reads. */
					/* ... tool-specific body here; see per-tool tasks in Phase E ... */

					/* 5. Persist via the context (awaits Firestore save). */
					/* await mcpCtx.recordMutations(mutations, nextDoc, "<stage>"); */

					/* 6. Emit progress (no-op without client token). */
					/* progress.notify("<stage>", "<human message>", { app_id: args.app_id }); */

					/* 7. Return human-readable success. */
					return {
						content: [{ type: "text", text: "<success summary>" }],
						_meta: { stage: "<stage>", app_id: args.app_id, run_id: runId },
					};
				} finally {
					await logWriter.flush();
				}
			} catch (err) {
				return toMcpErrorResult(err, { appId: args.app_id });
			}
		},
	);
}
```

**Variations by tool category:**

- **Read-only adapters** (`list_apps`, `get_app`, `compile_app`, `get_agent_prompt`, and shared read-only tools): skip the load-mutate-save block. Just call the shared tool's read path or MCP-only handler.
- **`create_app`**: no `app_id` in input, no ownership check (there's nothing to own yet). Just mint the app via `createApp(userId, runId)` + optional rename.
- **`get_agent_prompt`**: no `McpContext`, no `LogWriter` — just renders + returns. Pure meta.
- **`upload_app_to_hq`** (spelled out in Phase E to address S8): explicit 4-gate sequence — (1) regex-validate the `domain` arg via `isValidDomainSlug`; (2) load KMS-encrypted creds via `getDecryptedCredentialsWithDomain(userId)` — missing creds return a user-actionable error; (3) assert `decrypted.domain === args.domain`; (4) `importApp` against the hardcoded HQ base URL.
