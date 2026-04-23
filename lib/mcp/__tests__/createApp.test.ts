/**
 * `registerCreateApp` unit tests.
 *
 * Verifies the five load-bearing behaviors of the MCP-only create tool:
 *   - Happy path with a name: forwards `{ appName, status: "complete" }`
 *     to the DB helper, surfaces the returned `app_id`, and emits the
 *     `stage: "app_created"` + `run_id` markers MCP clients latch on.
 *   - Happy path without a name: normalizes the omitted optional to
 *     `undefined` so the DB helper's `""` default kicks in.
 *   - Whitespace-only name: normalized to `undefined` for the same
 *     reason — a blank row is strictly worse than an empty one.
 *   - Client-supplied `run_id` threads through from `extra._meta.run_id`
 *     and is what gets persisted on the app doc — admin surfaces can
 *     group subsequent tool calls under the same id.
 *   - `createApp` throws: surfaces as an MCP `isError: true` envelope
 *     classified through the shared taxonomy (with `run_id` stamped).
 *
 * The MCP SDK is mocked at the boundary through the shared
 * `makeFakeServer` helper that captures the handler callback.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/lib/db/apps";
import { registerCreateApp } from "../tools/createApp";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* Hoisted mock — installs before `../tools/createApp` resolves
 * `@/lib/db/apps`. Only `createApp` is replaced. */
vi.mock("@/lib/db/apps", () => ({
	createApp: vi.fn(),
}));

/* --- Helpers --------------------------------------------------------- */

/**
 * Loose UUID-v4 regex. Asserting on shape (rather than pinning an
 * exact value) keeps the test decoupled from `crypto.randomUUID()`'s
 * output while still catching regressions that would return a fixed
 * string or something structurally wrong.
 */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const toolCtx: ToolContext = { userId: "u1", scopes: [] };

beforeEach(() => {
	vi.mocked(createApp).mockReset();
});

/* --- Tests ----------------------------------------------------------- */

describe("registerCreateApp — happy path with name", () => {
	it("forwards the name and 'complete' status, returns the minted app_id", async () => {
		vi.mocked(createApp).mockResolvedValueOnce("app-123");

		const { server, capture } = makeFakeServer();
		registerCreateApp(server, toolCtx);

		const out = (await capture()({ app_name: "My App" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
			_meta: { stage: string; app_id: string; run_id: string };
		};

		expect(createApp).toHaveBeenCalledTimes(1);
		const [owner, runId, opts] = vi.mocked(createApp).mock.calls[0] ?? [];
		expect(owner).toBe("u1");
		/* Run id shape — mint-per-call via `crypto.randomUUID()`. We
		 * don't pin a specific value; we just verify it's a UUID v4. */
		expect(typeof runId).toBe("string");
		expect(runId).toMatch(UUID_RE);
		expect(opts).toEqual({ appName: "My App", status: "complete" });

		expect(JSON.parse(out.content[0]?.text ?? "{}")).toEqual({
			app_id: "app-123",
		});
		expect(out._meta.stage).toBe("app_created");
		expect(out._meta.app_id).toBe("app-123");
		expect(out._meta.run_id).toBe(runId);
	});
});

describe("registerCreateApp — happy path without name", () => {
	it("omits the appName (passes undefined) when no name is provided", async () => {
		vi.mocked(createApp).mockResolvedValueOnce("app-abc");

		const { server, capture } = makeFakeServer();
		registerCreateApp(server, toolCtx);

		await capture()({}, {});

		const [, , opts] = vi.mocked(createApp).mock.calls[0] ?? [];
		/* The DB helper's default `""` kicks in only when `appName` is
		 * undefined on the options object. Explicit presence with
		 * `undefined` is the expected shape. */
		expect(opts).toEqual({ appName: undefined, status: "complete" });
	});
});

describe("registerCreateApp — whitespace-only name", () => {
	it("normalizes a whitespace-only name to undefined", async () => {
		vi.mocked(createApp).mockResolvedValueOnce("app-xyz");

		const { server, capture } = makeFakeServer();
		registerCreateApp(server, toolCtx);

		await capture()({ app_name: "   " }, {});

		const [, , opts] = vi.mocked(createApp).mock.calls[0] ?? [];
		expect(opts).toEqual({ appName: undefined, status: "complete" });
	});
});

describe("registerCreateApp — run_id threading", () => {
	it("threads a client-supplied run_id through to the DB helper and the envelope", async () => {
		vi.mocked(createApp).mockResolvedValueOnce("app-threaded");

		const { server, capture } = makeFakeServer();
		registerCreateApp(server, toolCtx);

		const out = (await capture()(
			{ app_name: "Threaded" },
			{ _meta: { run_id: "client-rid-create" } },
		)) as {
			content: Array<{ type: "text"; text: string }>;
			_meta: { run_id: string; app_id: string };
		};

		/* The run id the DB helper persists on the new app doc MUST be
		 * the client-threaded one — otherwise admin surfaces grouping
		 * subsequent tool calls under the same `_meta.run_id` would
		 * point at a different runId than the persisted doc carries. */
		const [, runId] = vi.mocked(createApp).mock.calls[0] ?? [];
		expect(runId).toBe("client-rid-create");
		/* And the envelope stamps the same id — client sees its own id
		 * echoed back, confirming the round-trip. */
		expect(out._meta.run_id).toBe("client-rid-create");
	});
});

/* --- Type-level tests ------------------------------------------------ */

/**
 * Compile-time regression lock for `CreateAppOptions.status`. The
 * narrowed type rejects `"error"` and `"deleted"` — these calls must
 * NOT compile. `@ts-expect-error` fails the test suite build if the
 * assertion suddenly starts typechecking (e.g. a future widening of
 * the union), catching the regression at compile time rather than
 * waiting for a runtime surprise.
 *
 * Calls are wrapped in a `neverRun` guard so the references don't
 * execute — the `@ts-expect-error` directives ARE the assertions, not
 * any runtime behavior.
 */
function typeCheckCreateAppOptions(): void {
	const neverRun = false;
	if (neverRun) {
		// @ts-expect-error — "error" is not a valid creation status
		void createApp("u1", "rid", { status: "error" });
		// @ts-expect-error — "deleted" is not a valid creation status
		void createApp("u1", "rid", { status: "deleted" });
	}
}
/* Reference the guard so lint doesn't flag it as unused — the
 * directives inside are what the compiler enforces. */
void typeCheckCreateAppOptions;

describe("registerCreateApp — createApp throws", () => {
	it("surfaces as an MCP error envelope with populated error_type and run_id", async () => {
		vi.mocked(createApp).mockRejectedValueOnce(
			new Error("firestore write failed"),
		);

		const { server, capture } = makeFakeServer();
		registerCreateApp(server, toolCtx);

		const out = (await capture()(
			{ app_name: "x" },
			{ _meta: { run_id: "client-rid-err" } },
		)) as {
			isError?: true;
			_meta?: { error_type: string; run_id?: string };
		};
		expect(out.isError).toBe(true);
		expect(typeof out._meta?.error_type).toBe("string");
		expect(out._meta?.error_type.length ?? 0).toBeGreaterThan(0);
		/* Error envelope must carry the same run_id the success envelope
		 * would have — admin surfaces grouping by run id need to see
		 * failures under the same id as the successful calls. */
		expect(out._meta?.run_id).toBe("client-rid-err");
	});
});
