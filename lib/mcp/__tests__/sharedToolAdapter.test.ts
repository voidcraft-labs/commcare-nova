/**
 * `sharedToolAdapter` unit tests.
 *
 * Verifies the adapter's five load-bearing behaviors:
 *   - Read / mutating / validateApp result projection each produces the
 *     right MCP text payload. The mutating branch also proves the
 *     hard invariant that the adapter does NOT re-persist: the fake
 *     tool's `ctx.recordMutations` call is tracked and the adapter
 *     must not call it itself.
 *   - Ownership failures short-circuit before the tool executes and
 *     route through `toMcpErrorResult`.
 *   - `logWriter.flush()` is awaited even when the tool throws.
 *   - `run_id` is threaded from `extra._meta.run_id` when the client
 *     supplies it.
 *   - `app_id` is stripped from the payload before the shared tool's
 *     `execute` sees it.
 *
 * The MCP SDK is mocked at the boundary — we never instantiate a real
 * `McpServer`. `capture()` returns the registered handler callback so
 * each test drives the adapter directly without stream wire-up.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ToolExecutionContext } from "@/lib/agent/toolExecutionContext";
import type { MutatingToolResult } from "@/lib/agent/tools/common";
import { loadApp, loadAppOwner } from "@/lib/db/apps";
import type { AppDoc } from "@/lib/db/types";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import {
	projectResult,
	registerSharedTool,
	type SharedToolModule,
} from "../adapters/sharedToolAdapter";
import type { ToolContext } from "../types";

/* `vi.mock` hoists above imports so the mocks are in place by the time
 * `../adapters/sharedToolAdapter` (and its transitive imports) resolve
 * `@/lib/db/apps` + `@/lib/log/writer`. */
vi.mock("@/lib/db/apps", () => ({
	loadApp: vi.fn(),
	loadAppOwner: vi.fn(),
	updateApp: vi.fn().mockResolvedValue(undefined),
}));

/* `vi.mock` is hoisted above imports, so its factory can't close over
 * a top-level class declaration (the class isn't defined yet when the
 * factory runs). `vi.hoisted` lifts the class to the same hoist pass
 * as the mock, letting the mock factory reach it directly AND letting
 * the test body reach it afterward via the returned handle. Tests look
 * up the freshest `flush` spy on `LogWriterMock.instances.at(-1)` to
 * assert the adapter drained the buffer. */
const { LogWriterMock } = vi.hoisted(() => {
	class LogWriterMock {
		logEvent = vi.fn();
		flush = vi.fn().mockResolvedValue(undefined);
		static instances: LogWriterMock[] = [];
		constructor() {
			LogWriterMock.instances.push(this);
		}
	}
	return { LogWriterMock };
});
vi.mock("@/lib/log/writer", () => ({ LogWriter: LogWriterMock }));

/* --- Helpers --------------------------------------------------------- */

/**
 * Build a minimal valid `BlueprintDoc` with the fields `loadApp` will
 * hydrate. `fieldParent` is deliberately absent on the persistable
 * side — the adapter rebuilds it on load, and this shape tests that
 * code path.
 */
function mockBlueprint(): Omit<BlueprintDoc, "fieldParent"> {
	return {
		appId: "a1",
		appName: "Test",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
	};
}

/**
 * Capture the MCP handler the adapter registers via `server.tool`.
 * `server.server.notification` is a no-op spy — the progress emitter
 * invokes it when the client passes a `progressToken`; tests here
 * don't pass one so it stays silent.
 */
type Handler = (
	args: Record<string, unknown>,
	extra: Record<string, unknown>,
) => Promise<unknown>;
interface FakeServer {
	server: McpServer;
	capture(): Handler;
}

function makeFakeServer(): FakeServer {
	let captured: Handler | null = null;
	const server = {
		tool: (_n: string, _d: string, _s: unknown, cb: Handler) => {
			captured = cb;
		},
		server: { notification: vi.fn() },
	} as unknown as McpServer;
	return {
		server,
		capture: () => {
			if (!captured) throw new Error("handler not captured");
			return captured;
		},
	};
}

/** Baseline tool context used by every test. */
const toolCtx: ToolContext = { userId: "u1", scopes: [] };

/**
 * Look up the spy `flush` of the most recently constructed `LogWriter`.
 * The mock class pushes every `new`-built instance into its static
 * `instances` array; tests use this to verify the drain ran. `beforeEach`
 * clears the array so cross-test bleed is impossible.
 */
function latestFlushSpy(): ReturnType<typeof vi.fn> {
	const instance = LogWriterMock.instances.at(-1);
	if (!instance) throw new Error("no LogWriter constructed yet");
	return instance.flush;
}

beforeEach(() => {
	vi.mocked(loadApp).mockReset();
	vi.mocked(loadAppOwner).mockReset();
	LogWriterMock.instances = [];
	/* Default: ownership passes, app loads with an empty blueprint. Tests
	 * override these for the ownership-failure path. `AppDoc` carries
	 * Firestore `Timestamp` fields that tests don't care about — cast
	 * through `unknown` to keep the shape narrow without pulling in the
	 * Firestore Admin SDK just to fabricate a Timestamp. */
	vi.mocked(loadAppOwner).mockResolvedValue("u1");
	vi.mocked(loadApp).mockResolvedValue({
		owner: "u1",
		app_name: "Test",
		blueprint: mockBlueprint() as unknown as BlueprintDoc,
		connect_type: null,
		module_count: 0,
		form_count: 0,
		status: "complete",
		error_type: null,
		run_id: null,
		created_at: new Date() as unknown as AppDoc["created_at"],
		updated_at: new Date() as unknown as AppDoc["updated_at"],
	});
});

/* --- Tests ----------------------------------------------------------- */

describe("registerSharedTool — read tools", () => {
	it("wraps a read-tool return verbatim in the MCP text envelope", async () => {
		const readTool: SharedToolModule = {
			description: "echo",
			inputSchema: z.object({ q: z.string() }),
			async execute(input) {
				/* Read tools take input + ctx + doc; we echo the input to prove
				 * the adapter forwarded correctly. */
				const typed = input as { q: string };
				return { query: typed.q, results: [] };
			},
		};
		const { server, capture } = makeFakeServer();
		registerSharedTool(server, "echo_tool", readTool, toolCtx);

		const out = (await capture()({ app_id: "a1", q: "x" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
			_meta: { app_id: string; run_id: string };
		};

		expect(out.content).toEqual([
			{ type: "text", text: JSON.stringify({ query: "x", results: [] }) },
		]);
		expect(out._meta.app_id).toBe("a1");
		/* run_id is minted in-adapter when not provided; just assert it's
		 * a non-empty string so we don't couple the test to crypto.randomUUID. */
		expect(typeof out._meta.run_id).toBe("string");
		expect(out._meta.run_id.length).toBeGreaterThan(0);
	});
});

describe("registerSharedTool — mutating tools", () => {
	it("extracts result.result and does NOT re-persist mutations", async () => {
		/* The fake mutating tool records whether the adapter called
		 * `ctx.recordMutations` after the tool itself did. The invariant
		 * we're guarding against is double-persistence: every shared
		 * mutating tool already persists in its own body, so the adapter
		 * must not call recordMutations again. */
		const recordedByAdapter: Mutation[][] = [];
		let toolSawRecordMutations = false;

		const mut: Mutation = { kind: "setAppName", name: "x" };

		const writeTool: SharedToolModule = {
			description: "mut",
			inputSchema: z.object({ val: z.string() }),
			async execute(_input, ctx: ToolExecutionContext, doc: BlueprintDoc) {
				/* Simulate what every shared mutating tool does: call
				 * recordMutations inside its own body. */
				await ctx.recordMutations([mut], doc, "stage:x");
				toolSawRecordMutations = true;
				const result: MutatingToolResult<{ ok: true }> = {
					mutations: [mut],
					newDoc: doc,
					result: { ok: true },
				};
				return result;
			},
		};

		/* Patch McpContext.recordMutations on its prototype so we can see
		 * every call from both the tool AND (if any) the adapter. The
		 * tool's call should fire once; the adapter's call should never
		 * fire. */
		const { McpContext } = await import("../context");
		const originalRecord = McpContext.prototype.recordMutations;
		McpContext.prototype.recordMutations = vi
			.fn()
			.mockImplementation(async (muts: Mutation[]) => {
				recordedByAdapter.push(muts);
				return [];
			});

		try {
			const { server, capture } = makeFakeServer();
			registerSharedTool(server, "mut_tool", writeTool, toolCtx);

			const out = (await capture()({ app_id: "a1", val: "y" }, {})) as {
				content: Array<{ type: "text"; text: string }>;
			};

			expect(toolSawRecordMutations).toBe(true);
			/* Exactly ONE recordMutations call — from inside the tool.
			 * This counts calls across BOTH paths: if a future contributor
			 * adds adapter-side `ctx.recordMutations`, this length jumps to
			 * 2 and the test fails. It's the guardrail for the "no
			 * double-persistence" invariant documented at the top of
			 * `sharedToolAdapter.ts`. */
			expect(recordedByAdapter).toHaveLength(1);
			expect(recordedByAdapter[0]).toEqual([mut]);

			/* Payload is the unwrapped `result.result` — not the full
			 * MutatingToolResult. */
			expect(out.content[0]?.text).toBe(JSON.stringify({ ok: true }));
		} finally {
			McpContext.prototype.recordMutations = originalRecord;
		}
	});
});

describe("registerSharedTool — validateApp projection", () => {
	it("drops doc + hqJson; surfaces success=false with errors", async () => {
		const validateLike: SharedToolModule = {
			description: "validate",
			inputSchema: z.object({}),
			async execute(_input, _ctx, doc) {
				return {
					success: false,
					doc, // full BlueprintDoc — must NOT appear in output
					hqJson: { big: "payload" }, // must NOT appear in output
					errors: ["e1"],
				};
			},
		};

		const { server, capture } = makeFakeServer();
		registerSharedTool(server, "validate_app", validateLike, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.content[0]?.text).toBe(
			JSON.stringify({ success: false, errors: ["e1"] }),
		);
	});

	it("emits only success=true on a successful validation", async () => {
		const validateLike: SharedToolModule = {
			description: "validate",
			inputSchema: z.object({}),
			async execute(_input, _ctx, doc) {
				return { success: true, doc };
			},
		};

		const { server, capture } = makeFakeServer();
		registerSharedTool(server, "validate_app", validateLike, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.content[0]?.text).toBe(JSON.stringify({ success: true }));
	});
});

describe("registerSharedTool — ownership failure", () => {
	it("returns an MCP error envelope when the user doesn't own the app", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce(null);
		const anyTool: SharedToolModule = {
			description: "unused",
			inputSchema: z.object({}),
			async execute() {
				throw new Error("should not be called");
			},
		};

		const { server, capture } = makeFakeServer();
		registerSharedTool(server, "any", anyTool, toolCtx);

		const out = (await capture()({ app_id: "ghost" }, {})) as {
			isError: true;
			content: Array<{ type: "text"; text: string }>;
			_meta: { error_type: string; app_id: string };
		};
		expect(out.isError).toBe(true);
		expect(out._meta.error_type).toBe("not_found");
		expect(out._meta.app_id).toBe("ghost");
	});
});

describe("registerSharedTool — logWriter flush on error", () => {
	it("awaits flush() even when the tool throws mid-execute", async () => {
		const throwingTool: SharedToolModule = {
			description: "boom",
			inputSchema: z.object({}),
			async execute() {
				throw new Error("boom");
			},
		};

		const { server, capture } = makeFakeServer();
		registerSharedTool(server, "boom_tool", throwingTool, toolCtx);

		await capture()({ app_id: "a1" }, {});

		/* After the tool threw, the adapter must have still flushed the
		 * writer buffer — otherwise queued events would be lost. */
		const flush = latestFlushSpy();
		expect(flush).toHaveBeenCalledTimes(1);
	});
});

describe("registerSharedTool — run_id threading + app_id stripping", () => {
	it("threads run_id from extra._meta.run_id into the response", async () => {
		const readTool: SharedToolModule = {
			description: "r",
			inputSchema: z.object({}),
			async execute() {
				return { ok: true };
			},
		};
		const { server, capture } = makeFakeServer();
		registerSharedTool(server, "r_tool", readTool, toolCtx);

		const out = (await capture()(
			{ app_id: "a1" },
			{ _meta: { run_id: "rid-123" } },
		)) as { _meta: { run_id: string } };

		expect(out._meta.run_id).toBe("rid-123");
	});

	it("strips app_id from the input forwarded to the shared tool", async () => {
		/* Tracks what the shared tool saw. We use a mutable capture rather
		 * than an expect inside the closure so the test's assertion shows
		 * the actual seen input if it fails. */
		let seen: Record<string, unknown> | null = null;

		const introspectTool: SharedToolModule = {
			description: "i",
			inputSchema: z.object({ payload: z.string() }),
			async execute(input) {
				seen = input as Record<string, unknown>;
				return { ok: true };
			},
		};

		const { server, capture } = makeFakeServer();
		registerSharedTool(server, "i_tool", introspectTool, toolCtx);

		await capture()({ app_id: "a1", payload: "p" }, {});

		expect(seen).not.toBeNull();
		/* Use Object.keys + includes so a false positive from an
		 * `in` check on a primitive can't mask a leak. */
		const keys = Object.keys(seen ?? {});
		expect(keys).not.toContain("app_id");
		expect(keys).toContain("payload");
	});
});

describe("projectResult — direct", () => {
	it("passes read-tool returns through unchanged", () => {
		const raw = { query: "x", results: [1, 2, 3] };
		expect(projectResult(raw)).toBe(raw);
	});

	it("unwraps a MutatingToolResult to its `result` field", () => {
		const newDoc = mockBlueprint() as unknown as BlueprintDoc;
		const raw: MutatingToolResult<{ ok: true }> = {
			mutations: [{ kind: "setAppName", name: "x" }],
			newDoc,
			result: { ok: true },
		};
		expect(projectResult(raw)).toEqual({ ok: true });
	});

	it("projects a failed validateApp result to { success, errors }", () => {
		const raw = {
			success: false,
			doc: mockBlueprint(),
			hqJson: { huge: "payload" },
			errors: ["e"],
		};
		expect(projectResult(raw)).toEqual({ success: false, errors: ["e"] });
	});

	it("projects a successful validateApp result to just { success }", () => {
		const raw = {
			success: true,
			doc: mockBlueprint(),
			hqJson: { huge: "payload" },
		};
		expect(projectResult(raw)).toEqual({ success: true });
	});

	it("returns primitives unchanged", () => {
		expect(projectResult("raw")).toBe("raw");
		expect(projectResult(42)).toBe(42);
		expect(projectResult(null)).toBe(null);
	});

	it("isMutatingToolResult rejects wrong-typed fields — falls through to read branch", () => {
		/* Keys match but `newDoc` is a string, not an object. The
		 * tightened predicate must reject this and fall through to the
		 * pass-through read branch rather than unwrapping `result`. */
		const raw = { mutations: [], newDoc: "str", result: {} };
		expect(projectResult(raw)).toBe(raw);
	});

	it("isValidateAppResult rejects wrong-typed fields — falls through to read branch", () => {
		/* `success` + `doc` present, but `doc` is a string. The
		 * tightened predicate must reject this and fall through to the
		 * pass-through read branch. */
		const raw = { success: true, doc: "not-an-object" };
		expect(projectResult(raw)).toBe(raw);
	});
});
