# Phase C — MCP endpoint skeleton

**Goal:** Build the per-request machinery that every MCP tool handler will share: a source-tagged event log, an MCP-variant context, a progress emitter, ownership + scope + rate-limit guards, a classified-error serializer, and the shared types that tool handlers depend on.

**Dependencies:** Phase B (OAuth plugin installed — tool handlers receive JWT claims from the route handler that lands in Phase F, so types must be defined now).

---

## Task C1: Event-source tagging on the log stream

Every event written by the MCP path needs `source: "mcp"` so analytics can distinguish surfaces. Threading this in requires a tiny core schema change + per-call-site propagation.

**Files:**
- Modify: `lib/log/types.ts`
- Modify: `lib/log/writer.ts`
- Modify: `lib/agent/generationContext.ts`
- Modify: `app/api/chat/route.ts`
- Modify: `lib/log/__tests__/writer.test.ts` (if one exists; otherwise add to the existing event-log test suite under `lib/log/__tests__/`)

- [ ] **Step 1: Add `source` to the event envelope schema**

Edit `lib/log/types.ts`. Locate `envelopeSchema` (currently defined around line 138) and add a `source` field:

```ts
const envelopeSchema = z.object({
	runId: z.string(),
	ts: z.number(),
	seq: z.number(),
	/**
	 * Which entrypoint produced this event. "chat" = web chat route
	 * (/api/chat, SSE + session cookie); "mcp" = MCP endpoint
	 * (/api/mcp, HTTP JSON-RPC + OAuth bearer). Analytics and admin
	 * debugging split surfaces on this tag.
	 */
	source: z.enum(["chat", "mcp"]),
});
```

If the schema already extends `mutationEventSchema` + `conversationEventSchema` via `envelopeSchema.extend(...)`, the `source` field flows through automatically to both. Re-export the inferred types unchanged.

- [ ] **Step 2: Plumb `source` through `LogWriter`**

Edit `lib/log/writer.ts`. Change the constructor to accept a `source`:

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
		/* Stamp the source tag on every envelope so downstream consumers
		 * (admin dashboards, analytics jobs) can filter by surface without
		 * inferring from other fields. Call sites never set this directly
		 * — the writer owns it. */
		const stamped = { ...event, source: this.source };
		// ...existing batching / persist logic, now writing `stamped`...
	}
}
```

If `logEvent` currently takes a parameter type that doesn't include `source`, the stamped object still satisfies the extended envelope — TypeScript should accept the spread as long as `MutationEvent` / `ConversationEvent` now include `source` via the schema change.

- [ ] **Step 3: Update the chat route to pass `source: "chat"`**

Edit `app/api/chat/route.ts`. Find the existing `new LogWriter(appId)` (around line 177) and change to:

```ts
const logWriter = new LogWriter(appId, "chat");
```

Also check `lib/agent/generationContext.ts` — if `GenerationContext` ever constructs its own `LogWriter` internally, update there too. (Current shape takes `logWriter` as a constructor opt, so no internal construction — but verify.)

- [ ] **Step 4: Update existing tests**

Any test that constructs `new LogWriter(appId)` must now pass a source. The mechanical fix is `new LogWriter(appId, "chat")` for all existing call sites (they all pre-date MCP). Run:

```bash
grep -rn "new LogWriter(" lib/ app/ components/ --include="*.ts" --include="*.tsx"
```

Update each. Tests that assert event-envelope shape should now also assert `source: "chat"` on the writes.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run && npx tsc --noEmit && echo "✓"`
Expected: everything green. If any event-schema test fails, it's almost certainly an assertion missing `source` — add the field.

- [ ] **Step 6: Commit**

```bash
git add lib/log/types.ts lib/log/writer.ts lib/agent/generationContext.ts app/api/chat/route.ts lib/log/__tests__
git commit -m "feat(log): tag events with source (chat|mcp) on the envelope"
```

---

## Task C2: Shared MCP types module

All tool files need the same `ToolContext` shape. Putting it in a dedicated types module avoids a circular dependency between `lib/mcp/server.ts` (which uses `ToolContext` in its `registerNovaTools` signature) and the tool modules (which import `ToolContext` to type their register functions).

**Files:**
- Create: `lib/mcp/types.ts`

- [ ] **Step 1: Write `lib/mcp/types.ts`**

```ts
/**
 * Shared MCP types.
 *
 * Single source of truth for request-scoped types that flow from the MCP
 * route handler (app/api/mcp/route.ts) into every tool handler. Kept in a
 * separate module so tool files can import without creating a cycle with
 * lib/mcp/server.ts (which depends on them).
 */

/**
 * Per-request context the MCP route handler materializes from the verified
 * JWT claims. Passed to each tool's `register<Tool>(server, ctx)` call so
 * tool handlers can resolve the authenticated user + granted scopes without
 * re-parsing the token.
 */
export interface ToolContext {
	/** Better Auth user id, from the JWT `sub` claim. */
	userId: string;
	/** Space-separated `scope` claim, split into individual scopes. */
	scopes: readonly string[];
}

/**
 * JWT claim shape the route handler receives post-verification. Exported
 * so the scope helper can type its parameter against it.
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

## Task C3: `McpContext` — MCP-variant of `GenerationContext`

**Files:**
- Create: `lib/mcp/context.ts`
- Create: `lib/mcp/__tests__/context.test.ts`

- [ ] **Step 1: Write `lib/mcp/context.ts`**

```ts
/**
 * McpContext — request-scoped glue for MCP tool handlers.
 *
 * Mirrors lib/agent/generationContext.ts for the MCP path: owns the event
 * log writer and progress emitter so tool handlers can persist mutations +
 * conversation events and announce progress through a single API.
 *
 * Diverges from GenerationContext in three ways:
 *   - No Anthropic client. The MCP server does not reason; the client does.
 *   - No UsageAccumulator. There are no LLM tokens to bill on this surface.
 *   - Progress goes out as MCP `notifications/progress` events, not SSE.
 *
 * Lifecycle: one McpContext per tool call. `runId` is minted per call
 * (there's no concept of a multi-call "run" on the MCP surface — the
 * client drives the loop). The log groups per-app via `appId + ts + seq`,
 * not per runId; runId is a grouping hint, not load-bearing.
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
import { log } from "@/lib/logger";
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

	/**
	 * Persist a mutation batch: log + Firestore save. Returns the log
	 * envelopes so callers can cross-reference stages.
	 */
	recordMutations(
		mutations: Mutation[],
		doc: BlueprintDoc,
		stage?: string,
	): MutationEvent[] {
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
		this.saveBlueprint(doc);
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

	private saveBlueprint(doc: BlueprintDoc) {
		const { fieldParent, ...persistable } = doc;
		void fieldParent;
		updateApp(this.appId, persistable).catch((err) =>
			log.error("[mcp.saveBlueprint] failed", err),
		);
	}
}
```

Note: the `source: "mcp"` on each envelope duplicates what the `LogWriter` stamps in Task C1. That's intentional — the context-side stamp makes the source visible in the returned envelope array (useful for tests + future in-memory consumers); the writer-side stamp is the load-bearing one for what actually lands in Firestore. If the two ever disagree, the writer wins.

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
	it("writes one log event per mutation and advances seq", () => {
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
		const events = ctx.recordMutations(muts, mockDoc(), "scaffold");
		expect(events).toHaveLength(2);
		expect(events[0].seq).toBe(0);
		expect(events[1].seq).toBe(1);
		expect(events.every((e) => e.source === "mcp")).toBe(true);
		expect(events.every((e) => e.stage === "scaffold")).toBe(true);
		expect(
			(logWriter.logEvent as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(2);
	});

	it("no-ops on empty mutation batch", () => {
		const logWriter = mockLogWriter();
		const ctx = new McpContext({
			appId: "a",
			userId: "u",
			runId: "r",
			logWriter,
			progress: mockProgress(),
		});
		expect(ctx.recordMutations([], mockDoc())).toEqual([]);
		expect(
			(logWriter.logEvent as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(0);
	});

	it("stamps source=mcp on conversation events", () => {
		const ctx = new McpContext({
			appId: "a",
			userId: "u",
			runId: "r",
			logWriter: mockLogWriter(),
			progress: mockProgress(),
		});
		const event = ctx.recordConversation({
			type: "assistant-text",
			text: "hi",
		});
		expect(event.source).toBe("mcp");
	});
});
```

- [ ] **Step 3: Run + type-check + commit**

```bash
npx vitest run lib/mcp/__tests__/context.test.ts
npx tsc --noEmit && echo "✓"
git add lib/mcp/context.ts lib/mcp/__tests__/context.test.ts
git commit -m "feat(mcp): McpContext with source-tagged event writes"
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
 * Tool-side contract: a single `notify(stage, message, extra?)` call. The
 * handler serializes a spec-compliant `notifications/progress` event with
 * structured `_meta` for programmatic consumers + human `message` for UIs
 * like Claude Code that render tool-progress text verbatim.
 *
 * When the client didn't opt in to progress (no `_meta.progressToken` on
 * the call), notify() is a no-op so tools can uniformly emit without
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

If the MCP SDK's `McpServer` exposes the raw `server.notification` at a different path than `server.server.notification`, adjust to match the SDK. Context7 the SDK docs when wiring this up if the path is ambiguous.

- [ ] **Step 2: Commit**

```bash
git add lib/mcp/progress.ts
git commit -m "feat(mcp): progress emitter with chapter-aligned stage taxonomy"
```

---

## Task C5: Ownership + scope + rate-limit + error helpers

Four small modules, one commit — they're tightly related (all error paths into a single classified-result helper).

**Files:**
- Create: `lib/mcp/ownership.ts`
- Create: `lib/mcp/scopes.ts`
- Create: `lib/mcp/rateLimit.ts`
- Create: `lib/mcp/errors.ts`
- Create: `lib/mcp/__tests__/scopes.test.ts`
- Create: `lib/mcp/__tests__/rateLimit.test.ts`

- [ ] **Step 1: Write `lib/mcp/ownership.ts`**

```ts
/**
 * Per-request ownership + concurrency guards.
 *
 * Every tool that takes an app_id runs ownership first (short-circuit on
 * unauthorized), then concurrency for writes. Reads skip concurrency —
 * list/get can happen during a build without blocking.
 */

import { hasActiveGeneration, loadAppOwner } from "@/lib/db/apps";

export class McpForbiddenError extends Error {
	constructor(public readonly reason: "not_found" | "not_owner") {
		super(reason);
		this.name = "McpForbiddenError";
	}
}

export class McpConflictError extends Error {
	constructor() {
		super("generation_in_progress");
		this.name = "McpConflictError";
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

export async function requireNoActiveGeneration(
	userId: string,
	appId: string,
): Promise<void> {
	const inFlight = await hasActiveGeneration(userId, appId);
	if (inFlight) throw new McpConflictError();
}
```

- [ ] **Step 2: Write `lib/mcp/scopes.ts`**

```ts
/**
 * OAuth scope enforcement at the tool layer.
 *
 * The JWT's `scope` claim is space-separated. Each tool declares its
 * required scope; tools call requireScope(ctx, <scope>) at the top of
 * their handler body.
 */

import type { JwtClaims, ToolContext } from "./types";

export const SCOPES = {
	read: "nova.read",
	write: "nova.write",
} as const;

export type RequiredScope = (typeof SCOPES)[keyof typeof SCOPES];

export class McpScopeError extends Error {
	constructor(public readonly required: RequiredScope) {
		super(`insufficient_scope: ${required}`);
		this.name = "McpScopeError";
	}
}

/** True if the context's granted scopes include the required one. */
export function hasScope(
	ctx: { scopes: readonly string[] },
	required: RequiredScope,
): boolean {
	return ctx.scopes.includes(required);
}

/** Throws `McpScopeError` if the scope is missing. */
export function requireScope(
	ctx: { scopes: readonly string[] },
	required: RequiredScope,
): void {
	if (!hasScope(ctx, required)) throw new McpScopeError(required);
}

/** Parse the JWT's space-separated scope claim into an array. */
export function parseScopes(jwt: JwtClaims): string[] {
	return (jwt.scope ?? "").split(/\s+/).filter(Boolean);
}

/** Compile-time assertion that ToolContext conforms to the scope shape. */
const _toolContextHasScopes: ToolContext["scopes"] extends readonly string[]
	? true
	: never = true;
void _toolContextHasScopes;
```

- [ ] **Step 3: Write `lib/mcp/__tests__/scopes.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { hasScope, McpScopeError, parseScopes, requireScope, SCOPES } from "../scopes";

describe("scopes", () => {
	it("parseScopes handles space-separated claims", () => {
		expect(parseScopes({ sub: "u", scope: "openid nova.read nova.write" }))
			.toEqual(["openid", "nova.read", "nova.write"]);
	});
	it("parseScopes returns empty array for missing claim", () => {
		expect(parseScopes({ sub: "u" })).toEqual([]);
	});
	it("hasScope is true when included", () => {
		expect(hasScope({ scopes: ["nova.read", "nova.write"] }, SCOPES.read))
			.toBe(true);
	});
	it("hasScope is false when absent", () => {
		expect(hasScope({ scopes: ["openid"] }, SCOPES.write)).toBe(false);
	});
	it("requireScope throws McpScopeError when missing", () => {
		expect(() => requireScope({ scopes: ["openid"] }, SCOPES.write)).toThrow(
			McpScopeError,
		);
	});
});
```

- [ ] **Step 4: Write `lib/mcp/rateLimit.ts`**

```ts
/**
 * Per-user-per-tool-per-minute rate limiter backed by Firestore.
 *
 * Scoped narrowly so one user spamming one tool can't DOS another user
 * or another tool. Each bucket is a Firestore doc at:
 *
 *   mcp_rate_limits/{userId}_{toolName}_{minute}
 *
 * with a `count` field incremented atomically inside a transaction. Old
 * buckets expire via Firestore TTL (configured outside this file).
 *
 * Limits come from the spec:
 *   - generate_* / add_module / create_app / delete_app / upload   → 10/min
 *   - field + module + form mutations                              → 60/min
 *   - validate_app / compile_app                                   → 30/min
 *   - reads (list_apps / get_* / search_blueprint / get_agent_prompt) → 120/min
 */

import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "@/lib/db/firestore";

export class McpRateLimitError extends Error {
	constructor(
		public readonly toolName: string,
		public readonly retryAfterSec: number,
	) {
		super(`rate_limited: ${toolName}`);
		this.name = "McpRateLimitError";
	}
}

const LIMITS: Record<string, number> = {
	generate_schema: 10,
	generate_scaffold: 10,
	add_module: 10,
	create_app: 10,
	delete_app: 10,
	upload_app_to_hq: 10,
	create_module: 60,
	create_form: 60,
	add_field: 60,
	add_fields: 60,
	edit_field: 60,
	remove_field: 60,
	remove_form: 60,
	remove_module: 60,
	update_form: 60,
	update_module: 60,
	validate_app: 30,
	compile_app: 30,
	list_apps: 120,
	get_app: 120,
	get_module: 120,
	get_form: 120,
	get_field: 120,
	search_blueprint: 120,
	get_agent_prompt: 120,
};
const DEFAULT_LIMIT = 60;

export async function checkRateLimit(
	userId: string,
	toolName: string,
): Promise<void> {
	const limit = LIMITS[toolName] ?? DEFAULT_LIMIT;
	const minute = Math.floor(Date.now() / 60_000);
	const docId = `${userId}_${toolName}_${minute}`;
	const docRef = getDb().collection("mcp_rate_limits").doc(docId);

	const postCount = await getDb().runTransaction(async (tx) => {
		const cur = await tx.get(docRef);
		const count = (cur.data()?.count ?? 0) as number;
		if (count >= limit) return count;
		tx.set(
			docRef,
			{
				count: FieldValue.increment(1),
				expires_at: new Date((minute + 2) * 60_000),
			},
			{ merge: true },
		);
		return count + 1;
	});

	if (postCount > limit) {
		const secondsIntoMinute = Math.floor((Date.now() % 60_000) / 1000);
		throw new McpRateLimitError(toolName, 60 - secondsIntoMinute);
	}
}
```

- [ ] **Step 5: Write `lib/mcp/__tests__/rateLimit.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runTransaction = vi.fn();
const doc = vi.fn(() => ({}));
const collection = vi.fn(() => ({ doc }));
vi.mock("@/lib/db/firestore", () => ({
	getDb: () => ({ collection, runTransaction }),
}));

import { checkRateLimit, McpRateLimitError } from "../rateLimit";

describe("checkRateLimit", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-21T10:00:30Z"));
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("passes when bucket below limit", async () => {
		runTransaction.mockImplementation(async (fn) =>
			fn({
				get: async () => ({ data: () => ({ count: 5 }) }),
				set: vi.fn(),
			}),
		);
		await expect(checkRateLimit("u", "get_app")).resolves.toBeUndefined();
	});

	it("throws when bucket over limit", async () => {
		runTransaction.mockImplementation(async (fn) =>
			fn({
				get: async () => ({ data: () => ({ count: 120 }) }),
				set: vi.fn(),
			}),
		);
		await expect(checkRateLimit("u", "get_app")).rejects.toThrow(
			McpRateLimitError,
		);
	});
});
```

- [ ] **Step 6: Write `lib/mcp/errors.ts`**

```ts
/**
 * Classify + serialize tool errors to the MCP-shaped tool-result.
 *
 * MCP tool errors are a successful JSON-RPC response with `isError: true`
 * on the result. Nova's existing classifier produces the taxonomy; this
 * module bridges the two.
 */

import { classifyError } from "@/lib/agent/errorClassifier";
import { McpConflictError, McpForbiddenError } from "./ownership";
import { McpRateLimitError } from "./rateLimit";
import { McpScopeError } from "./scopes";

export interface McpToolErrorResult {
	isError: true;
	content: [{ type: "text"; text: string }];
	_meta: {
		error_type: string;
		app_id?: string;
		retry_after_sec?: number;
		required_scope?: string;
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
	if (err instanceof McpConflictError) {
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: "Another generation is already in progress for this app.",
				},
			],
			_meta: { error_type: "generation_in_progress", ...base },
		};
	}
	if (err instanceof McpRateLimitError) {
		return {
			isError: true,
			content: [{ type: "text", text: `Rate limited: ${err.toolName}` }],
			_meta: {
				error_type: "rate_limited",
				retry_after_sec: err.retryAfterSec,
				...base,
			},
		};
	}
	if (err instanceof McpScopeError) {
		return {
			isError: true,
			content: [{ type: "text", text: `Insufficient scope: ${err.required}` }],
			_meta: { error_type: "insufficient_scope", required_scope: err.required },
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

- [ ] **Step 7: Run the Phase C test suite + type-check**

```bash
npx vitest run lib/mcp/__tests__/
npx tsc --noEmit && echo "✓"
```

- [ ] **Step 8: Commit**

```bash
git add lib/mcp/ownership.ts lib/mcp/scopes.ts lib/mcp/rateLimit.ts lib/mcp/errors.ts lib/mcp/__tests__/scopes.test.ts lib/mcp/__tests__/rateLimit.test.ts
git commit -m "feat(mcp): ownership, scope, rate-limit, and error helpers"
```

---

## Canonical tool-handler template (read before Phase D)

Every tool file in `lib/mcp/tools/` follows this shape. Phase D tasks produce ~25 files that vary the body but share this frame.

```ts
/**
 * nova.<tool_name> — <one-line purpose>.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { produce } from "immer";
import { buildSolutionsArchitectPrompt } from "@/lib/agent/prompts";
import { <HELPER_FROM_BLUEPRINTHELPERS> } from "@/lib/agent/blueprintHelpers";
import { loadApp, updateApp } from "@/lib/db/apps";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { LogWriter } from "@/lib/log/writer";
import { McpContext } from "../context";
import { toMcpErrorResult } from "../errors";
import { requireOwnedApp, requireNoActiveGeneration } from "../ownership";
import { createProgressEmitter } from "../progress";
import { checkRateLimit } from "../rateLimit";
import { requireScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

export function register<Tool>(server: McpServer, ctx: ToolContext): void {
	server.tool(
		"<tool_name>",
		"<human-readable description for the LLM>",
		{
			type: "object",
			properties: {
				app_id: { type: "string" },
				/* ... */
			},
			required: ["app_id"],
			additionalProperties: false,
		},
		async (
			args: { app_id: string /* ... */ },
			meta: { _meta?: { progressToken?: string | number } },
		) => {
			try {
				/* 1. Scope + rate limit — O(1) in-memory / single Firestore read. */
				requireScope(ctx, SCOPES.<read|write>);
				await checkRateLimit(ctx.userId, "<tool_name>");

				/* 2. Ownership + concurrency (writes only). */
				await requireOwnedApp(ctx.userId, args.app_id);
				/* Write tools ONLY: */
				await requireNoActiveGeneration(ctx.userId, args.app_id);

				/* 3. Materialize per-call plumbing. runId is fresh per tool call
				 *    because MCP has no client-driven "run" concept; a multi-call
				 *    edit session is just many independent log runs, grouped via
				 *    appId + ts. */
				const runId = crypto.randomUUID();
				const logWriter = new LogWriter(args.app_id, "mcp");
				const progress = createProgressEmitter(server, meta._meta?.progressToken);
				const mcpCtx = new McpContext({
					appId: args.app_id,
					userId: ctx.userId,
					runId,
					logWriter,
					progress,
				});

				try {
					/* 4. Load doc, apply mutations, save. */
					const app = await loadApp(args.app_id);
					if (!app) throw new Error("not_found");
					const doc = { ...app, fieldParent: {} };
					rebuildFieldParent(doc);

					const muts = <HELPER_FROM_BLUEPRINTHELPERS>(doc, /* args */);
					const nextDoc = produce(doc, (draft) => {
						/* apply the mutations; see lib/doc/applyMutation for the
						 * in-place applier used on both surfaces. */
					});
					await updateApp(args.app_id, nextDoc);
					mcpCtx.recordMutations(muts, nextDoc, "<stage>");
					progress.notify("<stage>", "<human message>", {
						app_id: args.app_id,
					});

					/* 5. Return a human-readable success string. */
					return {
						content: [
							{ type: "text", text: "<success summary>" },
						],
						_meta: { stage: "<stage>", app_id: args.app_id },
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

- **Read-only tools** (`list_apps`, `get_app`, `get_module`, `get_form`, `get_field`, `search_blueprint`, `get_agent_prompt`): skip step 2b (`requireNoActiveGeneration`) and step 4's mutation/save block. They read only.
- **`create_app` / `delete_app`**: no `app_id` in input (create) or no ownership check required for create; `delete_app` only does ownership + soft-delete.
- **Tools with no Firestore app involvement** (`get_agent_prompt`): no ownership, no `McpContext`, no `LogWriter` — just scope + rate limit + return.
- **`validate_app`**: wraps `validateAndFix` from `lib/agent/validationLoop`; progress events for `validation_started`, `validation_fix_applied` (per fix attempt), `validation_passed`.
- **`compile_app`**: scope `read`, calls `expandDoc` (for `format: "json"`) or `compileCcz` (for `format: "ccz"`) from `lib/commcare/*`. CCZ is returned as base64-encoded text content.
- **`upload_app_to_hq`**: loads KMS-encrypted creds via `getDecryptedCredentialsWithDomain`, verifies domain match, expands doc, calls `importApp` from `lib/commcare/client`. Progress events `upload_started`, `upload_complete`.

Every tool emits `toMcpErrorResult` from its outer catch. Every mutation tool flushes its `logWriter` in the finally block so Firestore writes land before the response returns.

**Applier.** The inline `applyMutation` path the canonical template references is whatever the repo already uses on the client side for the same `Mutation[]` shape — check `lib/doc/` for the canonical applier function and import it rather than hand-rolling a switch inside each tool.
