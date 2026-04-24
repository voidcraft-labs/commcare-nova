/**
 * `registerCreateApp` unit tests.
 *
 * Verifies the four load-bearing behaviors of the MCP-only create tool:
 *   - Happy path with a name: forwards `{ appName, status: "complete" }`
 *     to the DB helper, surfaces the returned `app_id`, and emits the
 *     `stage: "app_created"` marker for progress clients.
 *   - Happy path without a name: normalizes the omitted optional to
 *     `undefined` so the DB helper's `""` default kicks in.
 *   - Whitespace-only name: normalized to `undefined` for the same
 *     reason — a blank row is strictly worse than an empty one.
 *   - A fresh server-minted run_id is persisted to the new app doc so
 *     the sliding-window derivation in subsequent MCP calls has an
 *     anchor to reuse (see `lib/mcp/runId.ts`).
 *   - `createApp` throws: surfaces as an MCP `isError: true` envelope
 *     classified through the shared taxonomy.
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
		};

		expect(createApp).toHaveBeenCalledTimes(1);
		const [owner, runId, opts] = vi.mocked(createApp).mock.calls[0] ?? [];
		expect(owner).toBe("u1");
		/* Server-minted run id seeds the new app doc. Shape-check only;
		 * we don't pin a specific value. */
		expect(typeof runId).toBe("string");
		expect(runId).toMatch(UUID_RE);
		expect(opts).toEqual({ appName: "My App", status: "complete" });

		/* Every structured signal rides in content JSON: the `stage`
		 * marker the model branches on plus the minted `app_id`. */
		expect(JSON.parse(out.content[0]?.text ?? "{}")).toEqual({
			stage: "app_created",
			app_id: "app-123",
		});
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

describe("registerCreateApp — run seed", () => {
	it("persists a unique UUID-v4 run id per call to the DB helper", async () => {
		/* Each create mints a fresh id — two back-to-back creates must
		 * produce different seeds, since each is the anchor for its own
		 * subsequent run. */
		vi.mocked(createApp).mockResolvedValueOnce("app-1");
		vi.mocked(createApp).mockResolvedValueOnce("app-2");

		const { server, capture } = makeFakeServer();
		registerCreateApp(server, toolCtx);
		await capture()({}, {});
		await capture()({}, {});

		const [, runIdA] = vi.mocked(createApp).mock.calls[0] ?? [];
		const [, runIdB] = vi.mocked(createApp).mock.calls[1] ?? [];
		expect(runIdA).toMatch(UUID_RE);
		expect(runIdB).toMatch(UUID_RE);
		expect(runIdA).not.toBe(runIdB);
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
	it("surfaces as an MCP error envelope with populated error_type", async () => {
		vi.mocked(createApp).mockRejectedValueOnce(
			new Error("firestore write failed"),
		);

		const { server, capture } = makeFakeServer();
		registerCreateApp(server, toolCtx);

		const out = (await capture()({ app_name: "x" }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type?: string;
			message?: string;
		};
		expect(typeof payload.error_type).toBe("string");
		expect(payload.error_type?.length ?? 0).toBeGreaterThan(0);
	});
});
