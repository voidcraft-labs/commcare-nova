/**
 * Unit tests for the CommCare HQ settings Server Actions
 * (`app/(app)/settings/actions.ts`).
 *
 * Mocks: `getSession` (auth-utils), `discoverAccessibleDomains` (the HQ
 * client orchestration), and the `@/lib/db/settings` writers/readers. The
 * actions never throw — they return discriminated-union results — so each
 * test asserts the result shape and the side-effect (what got persisted).
 *
 * The behavior this locks: verifying stores EVERY reachable space (the fix
 * for the silent-first-match bug), the picker action surfaces a rejection
 * message, and refresh maps an HQ status to a user-facing message.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ───────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	discoverAccessibleDomains: vi.fn(),
	saveCommCareSettings: vi.fn(),
	getCommCareSettings: vi.fn(),
	refreshApprovedDomains: vi.fn(),
	deleteCommCareSettings: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({
	getSession: mocks.getSession,
}));
vi.mock("@/lib/commcare/client", () => ({
	discoverAccessibleDomains: mocks.discoverAccessibleDomains,
}));
vi.mock("@/lib/db/settings", () => ({
	saveCommCareSettings: mocks.saveCommCareSettings,
	getCommCareSettings: mocks.getCommCareSettings,
	refreshApprovedDomains: mocks.refreshApprovedDomains,
	deleteCommCareSettings: mocks.deleteCommCareSettings,
}));

import { refreshDomainsAction, verifyAndSaveCredentials } from "../actions";

const SESSION = { user: { id: "u1", email: "alice@example.com" } };
const PROD = { name: "connect-ace-prod", displayName: "ACE Prod" };
const CRISPR = { name: "ace-crispr-connect", displayName: "CRISPR" };

beforeEach(() => {
	for (const fn of Object.values(mocks)) fn.mockReset();
	mocks.getSession.mockResolvedValue(SESSION);
});

describe("verifyAndSaveCredentials", () => {
	it("stores EVERY reachable space (not just the first) and returns the fresh settings", async () => {
		mocks.discoverAccessibleDomains.mockResolvedValue([PROD, CRISPR]);
		const settings = {
			configured: true,
			username: "alice@example.com",
			availableDomains: [PROD, CRISPR],
		};
		mocks.getCommCareSettings.mockResolvedValue(settings);

		const result = await verifyAndSaveCredentials(
			"alice@example.com",
			"key-xyz",
		);

		expect(result).toEqual({ success: true, settings });
		/* The fix for the silent-wrong-target bug: the full reachable set is
		 * persisted, not just the first space that passed. */
		expect(mocks.saveCommCareSettings).toHaveBeenCalledWith("u1", {
			username: "alice@example.com",
			apiKey: "key-xyz",
			approvedDomains: [PROD, CRISPR],
		});
	});

	it("requires authentication", async () => {
		mocks.getSession.mockResolvedValue(null);
		const result = await verifyAndSaveCredentials("a", "b");
		expect(result).toEqual({
			success: false,
			error: "Authentication required.",
		});
		expect(mocks.discoverAccessibleDomains).not.toHaveBeenCalled();
	});

	it("rejects a blank username / API key before touching HQ", async () => {
		expect(await verifyAndSaveCredentials("  ", "key")).toEqual({
			success: false,
			error: "Username is required.",
		});
		expect(await verifyAndSaveCredentials("alice", "  ")).toEqual({
			success: false,
			error: "API key is required.",
		});
		expect(mocks.discoverAccessibleDomains).not.toHaveBeenCalled();
	});

	it("maps an HQ API error to a contextual message and does not save", async () => {
		mocks.discoverAccessibleDomains.mockResolvedValue({
			success: false,
			status: 401,
		});
		const result = await verifyAndSaveCredentials("alice", "bad-key");
		expect(result).toEqual({
			success: false,
			error: "Invalid API key. Check that you copied it correctly.",
		});
		expect(mocks.saveCommCareSettings).not.toHaveBeenCalled();
	});

	it("rejects a key that reaches zero spaces", async () => {
		mocks.discoverAccessibleDomains.mockResolvedValue([]);
		const result = await verifyAndSaveCredentials("alice", "key");
		expect(result.success).toBe(false);
		expect(mocks.saveCommCareSettings).not.toHaveBeenCalled();
	});
});

describe("refreshDomainsAction", () => {
	it("returns the refreshed settings on success", async () => {
		const settings = {
			configured: true,
			username: "alice@example.com",
			availableDomains: [PROD, CRISPR],
		};
		mocks.refreshApprovedDomains.mockResolvedValue({ ok: true, settings });

		const result = await refreshDomainsAction();
		expect(result).toEqual({ success: true, settings });
	});

	it("maps an HQ error status to a user-facing message on failure", async () => {
		mocks.refreshApprovedDomains.mockResolvedValue({
			ok: false,
			kind: "hq_error",
			status: 429,
		});
		const result = await refreshDomainsAction();
		expect(result).toEqual({
			success: false,
			error: "Rate limited by CommCare HQ. Wait a moment and try again.",
		});
	});

	it("explains a key that now reaches zero spaces without clobbering settings", async () => {
		mocks.refreshApprovedDomains.mockResolvedValue({
			ok: false,
			kind: "no_spaces",
		});
		const result = await refreshDomainsAction();
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toContain("no longer reaches any project space");
			expect(result.error).toContain("unchanged");
		}
	});
});
