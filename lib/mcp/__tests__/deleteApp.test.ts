/**
 * `registerDeleteApp` unit tests.
 *
 * Covers the four paths the route handler has to care about:
 *   - Happy path: an owned app soft-deletes, the returned content
 *     JSON carries `stage: "app_deleted"` + `app_id` + `deleted: true`
 *     + `recoverable_until`.
 *   - Ownership failure: the wire collapses `"not_owner"` to
 *     `"not_found"` (IDOR hardening). `softDeleteApp` must not run.
 *   - App not found: `loadAppOwner` returns null — a probe for an
 *     arbitrary id must not leave soft-delete state behind.
 *   - `softDeleteApp` throws: the Firestore write rejection surfaces
 *     as an `isError: true` MCP envelope classified through the shared
 *     taxonomy (not the `McpAccessError` fast path).
 *
 * The MCP SDK is mocked at the boundary through the shared
 * `makeFakeServer` helper that captures the handler callback.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppOwner, softDeleteApp } from "@/lib/db/apps";
import { registerDeleteApp } from "../tools/deleteApp";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

/* Hoisted mock — installs before `../tools/deleteApp` resolves
 * `@/lib/db/apps`. Only the two functions the tool touches (one for
 * the ownership gate, one for the write) are replaced. */
vi.mock("@/lib/db/apps", () => ({
	loadAppOwner: vi.fn(),
	softDeleteApp: vi.fn(),
}));

/* --- Helpers --------------------------------------------------------- */

const toolCtx: ToolContext = { userId: "u1", scopes: [] };

/* Mock softDeleteApp's return value directly — the ISO format is an
 * implementation detail of the helper, exercised end-to-end in its
 * own unit test. */
const FIXED_RECOVERABLE_UNTIL = "2026-05-23T12:00:00.000Z";

beforeEach(() => {
	vi.mocked(loadAppOwner).mockReset();
	vi.mocked(softDeleteApp).mockReset();
});

/* --- Tests ----------------------------------------------------------- */

describe("registerDeleteApp — happy path", () => {
	it("soft-deletes an owned app and surfaces the recovery deadline", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		vi.mocked(softDeleteApp).mockResolvedValueOnce(FIXED_RECOVERABLE_UNTIL);

		const { server, capture } = makeFakeServer();
		registerDeleteApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			content: Array<{ type: "text"; text: string }>;
		};

		expect(softDeleteApp).toHaveBeenCalledWith("a1");
		expect(JSON.parse(out.content[0]?.text ?? "{}")).toEqual({
			stage: "app_deleted",
			app_id: "a1",
			deleted: true,
			recoverable_until: FIXED_RECOVERABLE_UNTIL,
		});
	});
});

describe("registerDeleteApp — ownership failure", () => {
	it("collapses not_owner to not_found on the wire (IDOR hardening) and never writes", async () => {
		/* IDOR hardening: a probing client must not be able to
		 * enumerate existing app ids by submitting delete attempts and
		 * watching for a `"not_owner"` signal. The wire collapses to
		 * `"not_found"` with the same text a genuinely missing id
		 * would produce. */
		vi.mocked(loadAppOwner).mockResolvedValueOnce("someone-else");

		const { server, capture } = makeFakeServer();
		registerDeleteApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			message: string;
			app_id: string;
		};
		expect(payload.error_type).toBe("not_found");
		expect(payload.message).toBe("App not found.");
		expect(payload.app_id).toBe("a1");
		/* Hard invariant: a cross-tenant probe must not leave soft-delete
		 * state behind. `softDeleteApp` must not run at all. */
		expect(softDeleteApp).not.toHaveBeenCalled();
	});
});

describe("registerDeleteApp — not found", () => {
	it("maps ownership-null to error_type = 'not_found' and never writes", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce(null);

		const { server, capture } = makeFakeServer();
		registerDeleteApp(server, toolCtx);

		const out = (await capture()({ app_id: "ghost" }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			app_id: string;
		};
		expect(payload.error_type).toBe("not_found");
		expect(payload.app_id).toBe("ghost");
		/* A probe against a nonexistent id must not reach softDeleteApp —
		 * the helper's `update()` would reject with NOT_FOUND, which is
		 * a correct signal for a real caller but wasteful noise when
		 * the ownership gate can rule it out first. */
		expect(softDeleteApp).not.toHaveBeenCalled();
	});
});

describe("registerDeleteApp — wire parity (IDOR regression lock)", () => {
	it("not_owner and not_found produce byte-identical envelopes", async () => {
		/* Regression lock for the IDOR hardening: both access-failure
		 * shapes must be byte-identical so a probing client has no
		 * signal to distinguish them. */
		vi.mocked(loadAppOwner).mockResolvedValueOnce("someone-else");
		const { server: sA, capture: capA } = makeFakeServer();
		registerDeleteApp(sA, toolCtx);
		const ownerMismatch = await capA()({ app_id: "probe-id" }, {});

		vi.mocked(loadAppOwner).mockResolvedValueOnce(null);
		const { server: sB, capture: capB } = makeFakeServer();
		registerDeleteApp(sB, toolCtx);
		const notFound = await capB()({ app_id: "probe-id" }, {});

		expect(JSON.stringify(ownerMismatch)).toBe(JSON.stringify(notFound));
		/* softDeleteApp was never invoked for either branch — probes
		 * must not leave state behind regardless of which path they
		 * hit. */
		expect(softDeleteApp).not.toHaveBeenCalled();
	});
});

describe("registerDeleteApp — softDeleteApp throws", () => {
	it("surfaces firestore write rejection through the shared taxonomy", async () => {
		vi.mocked(loadAppOwner).mockResolvedValueOnce("u1");
		vi.mocked(softDeleteApp).mockRejectedValueOnce(
			new Error("firestore write failed"),
		);

		const { server, capture } = makeFakeServer();
		registerDeleteApp(server, toolCtx);

		const out = (await capture()({ app_id: "a1" }, {})) as {
			isError?: true;
			content: Array<{ type: "text"; text: string }>;
		};
		expect(out.isError).toBe(true);
		const payload = JSON.parse(out.content[0]?.text ?? "{}") as {
			error_type: string;
			app_id: string;
		};
		/* Not the `McpAccessError` fast path — the write rejection is
		 * routed through `classifyError` and resolves to a generic
		 * taxonomy bucket (e.g. `internal`). Assert shape rather than an
		 * exact value so a future classifier refinement doesn't break
		 * the test. */
		expect(typeof payload.error_type).toBe("string");
		expect(payload.error_type).not.toBe("not_owner");
		expect(payload.error_type).not.toBe("not_found");
		expect(payload.app_id).toBe("a1");
	});
});
