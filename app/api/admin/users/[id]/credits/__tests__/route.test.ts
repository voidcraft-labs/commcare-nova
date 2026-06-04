/**
 * Tests for the admin credit reset/grant endpoint — the FIRST admin write
 * route in the codebase, and the harness that later admin write-route tests
 * copy.
 *
 * The route's two collaborators are mocked at the import boundary so the test
 * exercises only the route's own job — the requireAdmin gate, body parsing +
 * validation, the AdminActor it builds, and the action dispatch:
 *
 *   - `@/lib/auth-utils` → a drivable `requireAdmin` mock. The default
 *     (re-established in `beforeEach`, since vitest's global `clearMocks`
 *     clears call history but NOT implementations) resolves a fake admin
 *     `Session`; the 403 test overrides it with `mockRejectedValueOnce` so the
 *     rejection is consumed by exactly that one call and doesn't bleed forward.
 *   - `@/lib/db/credits` → `resetCredits` + `grantCredits` as bare `vi.fn()`s
 *     resolving `undefined`, so each test can assert the exact call args (the
 *     `(userId, who)` / `(userId, amount, who)` contract). `AdminActor` stays a
 *     type — types aren't mocked.
 *
 * `@/lib/apiError` is deliberately NOT mocked: the real `ApiError` /
 * `handleApiError` are the response envelope under test (a 400 vs 500 split for
 * malformed JSON only holds with the real status mapping).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/apiError";
import type { Session } from "@/lib/auth";

// `vi.mock` is hoisted above the imports below, so its factory can't close over
// outer consts — mock with bare `vi.fn()`s, then drive them via `vi.mocked`.
vi.mock("@/lib/auth-utils", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/db/credits", () => ({
	resetCredits: vi.fn(),
	grantCredits: vi.fn(),
}));

import { requireAdmin } from "@/lib/auth-utils";
import { grantCredits, resetCredits } from "@/lib/db/credits";
import { POST } from "../route";

/**
 * A minimal fake admin session carrying only the two fields the route reads
 * (`user.id` + `user.email`). Cast to `Session` so we don't have to construct
 * Better Auth's full session shape just to satisfy the type.
 */
const fakeAdminSession = {
	user: { id: "admin-1", email: "admin@x.com", role: "admin" },
	session: { id: "s", userId: "admin-1" },
} as unknown as Session;

/** Build the POST request the route handler is called with. */
function buildRequest(body: string): Request {
	return new Request("https://commcare.app/api/admin/users/u1/credits", {
		method: "POST",
		body,
	});
}

/** Invoke the handler with the async-params shape Next.js passes. */
function callRoute(body: string): Promise<Response> {
	return POST(buildRequest(body), { params: Promise.resolve({ id: "u1" }) });
}

beforeEach(() => {
	// `clearMocks` (vitest.config) wipes call history but leaves implementations.
	// Re-establish the default admin resolution every test so the 403 test's
	// one-shot rejection can't bleed into the next test.
	vi.mocked(requireAdmin).mockResolvedValue(fakeAdminSession);
});

describe("POST /api/admin/users/[id]/credits", () => {
	it("rejects a non-admin with 403 and touches neither credit function", async () => {
		vi.mocked(requireAdmin).mockRejectedValueOnce(
			new ApiError("Admin access required", 403),
		);

		const res = await callRoute(JSON.stringify({ action: "reset" }));

		expect(res.status).toBe(403);
		expect(resetCredits).not.toHaveBeenCalled();
		expect(grantCredits).not.toHaveBeenCalled();
	});

	it("resets with a reason: passes the reason through on the AdminActor", async () => {
		const res = await callRoute(
			JSON.stringify({ action: "reset", reason: "comping March outage" }),
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(resetCredits).toHaveBeenCalledTimes(1);
		expect(resetCredits).toHaveBeenCalledWith("u1", {
			actor: "admin-1",
			actorEmail: "admin@x.com",
			reason: "comping March outage",
		});
		expect(grantCredits).not.toHaveBeenCalled();
	});

	it("resets with no reason: passes reason as null", async () => {
		const res = await callRoute(JSON.stringify({ action: "reset" }));

		expect(res.status).toBe(200);
		expect(resetCredits).toHaveBeenCalledWith("u1", {
			actor: "admin-1",
			actorEmail: "admin@x.com",
			reason: null,
		});
	});

	it("grants a positive amount with reason: passes amount + AdminActor through", async () => {
		const res = await callRoute(
			JSON.stringify({ action: "grant", amount: 500, reason: "loyalty" }),
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(grantCredits).toHaveBeenCalledTimes(1);
		expect(grantCredits).toHaveBeenCalledWith("u1", 500, {
			actor: "admin-1",
			actorEmail: "admin@x.com",
			reason: "loyalty",
		});
		expect(resetCredits).not.toHaveBeenCalled();
	});

	it("rejects a grant with no amount as 400 carrying the grant-amount message in details", async () => {
		const res = await callRoute(JSON.stringify({ action: "grant" }));
		const body = await res.json();

		expect(res.status).toBe(400);
		// The bespoke top-line credit-action guidance — not a generic Zod string.
		expect(body.error).toMatch(/action "grant"/);
		// The grant-amount message must survive the validation path and reach the
		// client via `parsed.error.issues → ApiError.details`. This is the
		// assertion that proves the discriminated-union schema preserved the
		// custom message — a naive DU regresses the missing-amount case to Zod's
		// default "expected number, received undefined". The two fixes interlock
		// here: Fix 1's `{ error }` param is what keeps this assertion green.
		expect(body.details).toEqual(
			expect.arrayContaining([
				expect.stringContaining("positive whole credit amount"),
			]),
		);
		expect(resetCredits).not.toHaveBeenCalled();
		expect(grantCredits).not.toHaveBeenCalled();
	});

	it("rejects a negative grant amount as 400 carrying the grant-amount message in details", async () => {
		const res = await callRoute(
			JSON.stringify({ action: "grant", amount: -5 }),
		);
		const body = await res.json();

		expect(res.status).toBe(400);
		// Pins the custom message on the `.positive()` check specifically — without
		// it, a negative amount regresses to Zod's default "Too small" while the
		// status stays 400 and this test would otherwise pass blind.
		expect(body.details).toEqual(
			expect.arrayContaining([
				expect.stringContaining("positive whole credit amount"),
			]),
		);
		expect(grantCredits).not.toHaveBeenCalled();
	});

	it("rejects a fractional grant amount as 400 carrying the grant-amount message in details", async () => {
		const res = await callRoute(
			JSON.stringify({ action: "grant", amount: 1.5 }),
		);
		const body = await res.json();

		expect(res.status).toBe(400);
		// Pins the custom message on the `.int()` check specifically — without it, a
		// fractional amount regresses to Zod's default "expected int" while the
		// status stays 400 and this test would otherwise pass blind.
		expect(body.details).toEqual(
			expect.arrayContaining([
				expect.stringContaining("positive whole credit amount"),
			]),
		);
		expect(grantCredits).not.toHaveBeenCalled();
	});

	it("rejects an unknown action as 400", async () => {
		const res = await callRoute(JSON.stringify({ action: "delete" }));

		expect(res.status).toBe(400);
		expect(resetCredits).not.toHaveBeenCalled();
		expect(grantCredits).not.toHaveBeenCalled();
	});

	it("rejects malformed JSON as 400 with the JSON-guidance copy, not 500", async () => {
		const res = await callRoute("{not json");
		const body = await res.json();

		expect(res.status).toBe(400);
		// The JSON-parse path's bespoke message — proves a malformed body is
		// diagnosed for the client, not collapsed into a generic 500.
		expect(body.error).toContain("valid JSON");
		expect(resetCredits).not.toHaveBeenCalled();
		expect(grantCredits).not.toHaveBeenCalled();
	});
});
