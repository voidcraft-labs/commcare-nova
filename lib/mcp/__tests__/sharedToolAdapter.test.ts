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
 *   - `app_id` is stripped from the payload before the shared tool's
 *     `execute` sees it.
 *   - Real Phase-D tool modules round-trip cleanly through the adapter
 *     — synthetic fakes cover the shape variance, but a read and a
 *     mutating real tool smoke-test the full envelope contract against
 *     the actual `lib/agent/tools/*` modules.
 *
 * The MCP SDK is mocked at the boundary — we never instantiate a real
 * `McpServer`. `capture()` returns the registered handler callback so
 * each test drives the adapter directly without stream wire-up.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ToolExecutionContext } from "@/lib/agent/toolExecutionContext";
import type { MutatingToolResult } from "@/lib/agent/tools/common";
import type { ValidateAppResult } from "@/lib/agent/tools/validateApp";
import { loadApp } from "@/lib/db/apps";
import type { AppDoc } from "@/lib/db/types";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import {
	projectResult,
	registerSharedTool,
	type SharedToolModule,
} from "../adapters/sharedToolAdapter";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* `vi.mock` hoists above imports so the mocks are in place by the time
 * `../adapters/sharedToolAdapter` (and its transitive imports) resolve
 * `@/lib/db/apps` + `@/lib/log/writer`. */
vi.mock("@/lib/db/apps", () => ({
	loadApp: vi.fn(),
	updateAppForRun: vi.fn().mockResolvedValue(undefined),
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
 * Build a blueprint with one module + one form so `addFieldTool` can
 * reach its happy-path branch (resolveFormContext must find the form).
 * `fieldOrder[formUuid] = []` makes the form empty so the fake
 * `recordMutations` spy can observe a single successful insert without
 * the test having to fabricate existing fields. Matches the
 * `Omit<BlueprintDoc, "fieldParent">` shape `loadApp` returns on disk.
 */
function mockBlueprintWithForm(): {
	blueprint: Omit<BlueprintDoc, "fieldParent">;
	modUuid: Uuid;
	formUuid: Uuid;
} {
	const modUuid = asUuid("44444444-4444-4444-4444-444444444444");
	const formUuid = asUuid("55555555-5555-5555-5555-555555555555");
	return {
		blueprint: {
			appId: "a1",
			appName: "Test",
			connectType: null,
			caseTypes: null,
			modules: {
				[modUuid]: {
					uuid: modUuid,
					id: "patients",
					name: "Patients",
					caseType: "patient",
				},
			},
			forms: {
				[formUuid]: {
					uuid: formUuid,
					id: "register",
					name: "Register",
					type: "registration",
				},
			},
			fields: {},
			moduleOrder: [modUuid],
			formOrder: { [modUuid]: [formUuid] },
			fieldOrder: { [formUuid]: [] },
		},
		modUuid,
		formUuid,
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
	LogWriterMock.instances = [];
	/* Default: app loads owned by the caller with an empty blueprint —
	 * `loadAppBlueprint` ownership-gates internally on `app.owner ===
	 * userId`. Tests override `loadApp` to drive the failure paths.
	 * `AppDoc` carries Firestore `Timestamp` fields that tests don't
	 * care about — cast through `unknown` to keep the shape narrow
	 * without pulling in the Firestore Admin SDK just to fabricate a
	 * Timestamp. */
	vi.mocked(loadApp).mockResolvedValue({
		owner: "u1",
		app_name: "Test",
		blueprint: mockBlueprint() as unknown as BlueprintDoc,
		connect_type: null,
		module_count: 0,
		form_count: 0,
		status: "complete",
		error_type: null,
		/* Soft-delete fields default to null on any row that hasn't been
		 * soft-deleted. Adapter doesn't read them; they're here to keep
		 * the fixture shape a full `AppDoc`. */
		deleted_at: null,
		recoverable_until: null,
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
				 * the adapter forwarded correctly. The `kind: "read"` tag is
				 * the contract every read tool follows so the adapter
				 * dispatches via the discriminator. */
				const typed = input as { q: string };
				return { kind: "read", data: { query: typed.q, results: [] } };
			},
		};
		const { server, capture } = makeFakeServer();
		registerSharedTool(server, "echo_tool", readTool, toolCtx);

		const out = (await capture()({ app_id: "a1", q: "x" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		expect(out.content).toEqual([
			{ type: "text", text: JSON.stringify({ query: "x", results: [] }) },
		]);
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
					kind: "mutate",
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
					kind: "validate",
					success: false,
					doc, // full BlueprintDoc — must NOT appear in output
					hqJson: { big: "payload" } as never, // must NOT appear in output
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
				return { kind: "validate", success: true, doc };
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
	it("returns an MCP error envelope when the app row is missing", async () => {
		vi.mocked(loadApp).mockResolvedValueOnce(null);
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
		};
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			app_id: string;
		};
		expect(payload.error_type).toBe("not_found");
		expect(payload.app_id).toBe("ghost");
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

		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError: true;
			content: Array<{ type: "text"; text: string }>;
		};

		/* After the tool threw, the adapter must have still flushed the
		 * writer buffer — otherwise queued events would be lost. */
		const flush = latestFlushSpy();
		expect(flush).toHaveBeenCalledTimes(1);
		/* Mid-throw error content carries `app_id` so the model can
		 * correlate the failure back to the target app. */
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			app_id: string;
		};
		expect(payload.app_id).toBe("a1");
	});
});

describe("registerSharedTool — app_id stripping", () => {
	it("strips app_id from the input forwarded to the shared tool", async () => {
		/* `app_id` is an MCP-boundary injection — the shared tool input
		 * schemas don't declare it (the chat surface passes `appId` via
		 * `ctx.appId`). Leaking it through would either be silently
		 * ignored (on loose Zod schemas) or fail parsing (on strict
		 * schemas); stripping at the boundary is the uniform contract. */
		let seen: Record<string, unknown> | null = null;

		const introspectTool: SharedToolModule = {
			description: "i",
			inputSchema: z.object({ payload: z.string() }),
			async execute(input) {
				seen = input as Record<string, unknown>;
				return { kind: "read", data: { ok: true } };
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
	it("unwraps a `read` result to its `data` field", () => {
		const data = { query: "x", results: [1, 2, 3] };
		expect(projectResult({ kind: "read", data })).toBe(data);
	});

	it("unwraps a `mutate` result to its `result` field", () => {
		const newDoc = mockBlueprint() as unknown as BlueprintDoc;
		const raw: MutatingToolResult<{ ok: true }> = {
			kind: "mutate",
			mutations: [{ kind: "setAppName", name: "x" }],
			newDoc,
			result: { ok: true },
		};
		expect(projectResult(raw)).toEqual({ ok: true });
	});

	it("projects a failed `validate` result to { success, errors }", () => {
		const raw: ValidateAppResult = {
			kind: "validate",
			success: false,
			doc: mockBlueprint() as unknown as BlueprintDoc,
			hqJson: { huge: "payload" } as never,
			errors: ["e"],
		};
		expect(projectResult(raw)).toEqual({ success: false, errors: ["e"] });
	});

	it("projects a successful `validate` result to just { success }", () => {
		const raw: ValidateAppResult = {
			kind: "validate",
			success: true,
			doc: mockBlueprint() as unknown as BlueprintDoc,
			hqJson: { huge: "payload" } as never,
		};
		expect(projectResult(raw)).toEqual({ success: true });
	});
});

/* --- Real Phase-D tool integration ---------------------------------- */

/**
 * These tests register genuine `lib/agent/tools/*` modules (not the
 * synthetic fakes above) through the adapter and invoke the resulting
 * handler end-to-end. They guard against regressions where the adapter
 * loses alignment with the real `SharedToolModule` contract — a subtle
 * projection drift (e.g., unwrapping `.result` wrong for a real
 * mutating tool) that the synthetic fakes would miss.
 */
describe("registerSharedTool — real read tool integration (searchBlueprint)", () => {
	it("returns { query, results } JSON through the adapter envelope", async () => {
		/* `searchBlueprintTool` is a Phase-D shared read tool: pure,
		 * no mutations, no persistence. A good integration smoke test
		 * because it exercises the whole adapter path (ownership +
		 * load + execute + project + envelope) against a real module
		 * without any Firestore writes. */
		const { searchBlueprintTool } = await import(
			"@/lib/agent/tools/searchBlueprint"
		);

		const { server, capture } = makeFakeServer();
		registerSharedTool(
			server,
			"search_blueprint",
			searchBlueprintTool,
			toolCtx,
		);

		const out = (await capture()({ app_id: "a1", query: "any" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		/* Payload must carry the `{ query, results }` shape the real
		 * tool returns — empty blueprint yields no results, and the
		 * tool echoes the query back. */
		const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
			query: string;
			results: unknown[];
		};
		expect(parsed.query).toBe("any");
		expect(Array.isArray(parsed.results)).toBe(true);
		expect(parsed.results).toHaveLength(0);
	});
});

describe("registerSharedTool — real mutating tool integration (addField)", () => {
	it("projects MutatingToolResult → result on the error branch and does not re-persist", async () => {
		/* Covers the projection + error-shape contract on a real
		 * mutating tool, not the double-persistence invariant per se:
		 * the empty blueprint has no module at index 0, so
		 * `resolveFormContext` returns null and `addFieldTool` emits
		 * an empty mutations batch with a `{ error }` result. That
		 * exercises projection (MutatingToolResult → `result`) without
		 * needing a full module + form fixture. The happy-path sibling
		 * test below covers the "adapter doesn't double-persist"
		 * invariant against a real mutation that actually fires. */
		const { addFieldTool } = await import("@/lib/agent/tools/addField");

		/* Spy on `ctx.recordMutations` so any adapter-side re-persist
		 * would surface. The tool itself returns early with zero
		 * mutations on this branch, so the tool body also never calls
		 * it — the spy therefore must remain uncalled. */
		const { McpContext } = await import("../context");
		const originalRecord = McpContext.prototype.recordMutations;
		const recordSpy = vi.fn().mockResolvedValue([]);
		McpContext.prototype.recordMutations = recordSpy;

		try {
			const { server, capture } = makeFakeServer();
			registerSharedTool(server, "add_field", addFieldTool, toolCtx);

			const out = (await capture()(
				{
					app_id: "a1",
					moduleIndex: 0,
					formIndex: 0,
					field: { id: "q1", kind: "text", label: "Q1" },
				},
				{},
			)) as { content: Array<{ type: "text"; text: string }> };

			const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
				error?: string;
			};
			expect(typeof parsed.error).toBe("string");
			/* Neither the tool (empty batch) nor the adapter (invariant)
			 * called recordMutations. Zero total calls is the contract. */
			expect(recordSpy).not.toHaveBeenCalled();
		} finally {
			McpContext.prototype.recordMutations = originalRecord;
		}
	});

	it("happy path: fires the tool's own ctx.recordMutations exactly once; adapter stays hands-off", async () => {
		/* Drives `addFieldTool` on a blueprint that has a module + form
		 * so `resolveFormContext` succeeds and the tool reaches its
		 * mutation-emitting branch. `ctx.recordMutations` must fire
		 * exactly once (from inside the tool body) — a second call
		 * would mean the adapter is double-persisting, which is the
		 * invariant the no-re-persist contract guards. */
		const { addFieldTool } = await import("@/lib/agent/tools/addField");

		/* Override the default empty-blueprint `loadApp` mock with a
		 * one-module-one-form fixture. `fieldParent` is deliberately
		 * absent — the adapter's `loadAppBlueprint` rebuilds it on the
		 * way in. */
		const { blueprint } = mockBlueprintWithForm();
		vi.mocked(loadApp).mockResolvedValueOnce({
			owner: "u1",
			app_name: blueprint.appName,
			blueprint: blueprint as unknown as BlueprintDoc,
			connect_type: null,
			module_count: blueprint.moduleOrder.length,
			form_count: Object.values(blueprint.formOrder).reduce(
				(sum, ids) => sum + ids.length,
				0,
			),
			status: "complete",
			error_type: null,
			deleted_at: null,
			recoverable_until: null,
			run_id: null,
			created_at: new Date() as unknown as AppDoc["created_at"],
			updated_at: new Date() as unknown as AppDoc["updated_at"],
		});

		const { McpContext } = await import("../context");
		const originalRecord = McpContext.prototype.recordMutations;
		const recordSpy = vi.fn().mockResolvedValue([]);
		McpContext.prototype.recordMutations = recordSpy;

		try {
			const { server, capture } = makeFakeServer();
			registerSharedTool(server, "add_field", addFieldTool, toolCtx);

			const out = (await capture()(
				{
					app_id: "a1",
					moduleIndex: 0,
					formIndex: 0,
					field: { id: "q1", kind: "text", label: "Q1" },
				},
				{},
			)) as { content: Array<{ type: "text"; text: string }> };

			/* Payload is the unwrapped `.result` — a human-readable
			 * success string from the real tool. JSON.stringify of a
			 * plain string round-trips to the quoted form. */
			const text = out.content[0]?.text ?? "";
			expect(text.startsWith('"Successfully added field')).toBe(true);

			/* The core contract: exactly one `recordMutations` call,
			 * made by the tool body. If the adapter ever re-persisted,
			 * this count would be 2. */
			expect(recordSpy).toHaveBeenCalledTimes(1);
		} finally {
			McpContext.prototype.recordMutations = originalRecord;
		}
	});
});

describe("registerSharedTool — IDOR byte-parity regression lock", () => {
	it("not_owner and not_found produce byte-identical envelopes through the shared wrapper", async () => {
		/* Regression lock for the IDOR hardening on the shared surface.
		 * Every shared SA tool routes through this wrapper, so proving
		 * the envelope is byte-identical here covers the entire shared
		 * surface in one assertion. */
		const anyTool: SharedToolModule = {
			description: "unused",
			inputSchema: z.object({}),
			async execute() {
				throw new Error("should not be called");
			},
		};

		/* Case 1: row exists but owned by another user (not_owner).
		 * `loadAppBlueprint` throws `McpAccessError("not_owner")`;
		 * `toMcpErrorResult` collapses to `"not_found"` on the wire. */
		vi.mocked(loadApp).mockResolvedValueOnce({
			owner: "someone-else",
			app_name: "Test",
			blueprint: mockBlueprint() as unknown as BlueprintDoc,
			connect_type: null,
			module_count: 0,
			form_count: 0,
			status: "complete",
			error_type: null,
			deleted_at: null,
			recoverable_until: null,
			run_id: null,
			created_at: new Date() as unknown as AppDoc["created_at"],
			updated_at: new Date() as unknown as AppDoc["updated_at"],
		});
		const { server: sA, capture: capA } = makeFakeServer();
		registerSharedTool(sA, "any", anyTool, toolCtx);
		const notOwnerResult = await capA()({ app_id: "probe-id" }, {});

		/* Case 2: row missing (not_found). Envelope shape must be
		 * identical — same text, same `error_type`, same layout. */
		vi.mocked(loadApp).mockResolvedValueOnce(null);
		const { server: sB, capture: capB } = makeFakeServer();
		registerSharedTool(sB, "any", anyTool, toolCtx);
		const notFoundResult = await capB()({ app_id: "probe-id" }, {});

		/* Identical serialization proves there's no wire signal a
		 * probing client could use to distinguish the two cases. */
		expect(JSON.stringify(notOwnerResult)).toBe(JSON.stringify(notFoundResult));
	});
});
