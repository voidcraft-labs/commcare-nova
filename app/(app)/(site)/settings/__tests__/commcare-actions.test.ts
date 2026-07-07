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
 * for the silent-first-match bug) on the server the user picked, the picker
 * action surfaces a rejection message that names that server (a key only
 * works on the deployment that issued it), and refresh maps an HQ status to
 * a user-facing message.
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
			server: "production",
			availableDomains: [PROD, CRISPR],
		};
		mocks.getCommCareSettings.mockResolvedValue(settings);

		const result = await verifyAndSaveCredentials(
			"alice@example.com",
			"key-xyz",
			"production",
		);

		expect(result).toEqual({ success: true, settings });
		/* The fix for the silent-wrong-target bug: the full reachable set is
		 * persisted, not just the first space that passed. */
		expect(mocks.saveCommCareSettings).toHaveBeenCalledWith("u1", {
			username: "alice@example.com",
			apiKey: "key-xyz",
			server: "production",
			approvedDomains: [PROD, CRISPR],
		});
	});

	it("verifies against and stores the picked server, not a fixed one", async () => {
		mocks.discoverAccessibleDomains.mockResolvedValue([PROD]);
		const settings = {
			configured: true,
			username: "alice@example.com",
			server: "eu",
			availableDomains: [PROD],
		};
		mocks.getCommCareSettings.mockResolvedValue(settings);

		const result = await verifyAndSaveCredentials(
			"alice@example.com",
			"key-eu",
			"eu",
		);

		expect(result).toEqual({ success: true, settings });
		expect(mocks.discoverAccessibleDomains).toHaveBeenCalledWith({
			username: "alice@example.com",
			apiKey: "key-eu",
			server: "eu",
		});
		expect(mocks.saveCommCareSettings).toHaveBeenCalledWith("u1", {
			username: "alice@example.com",
			apiKey: "key-eu",
			server: "eu",
			approvedDomains: [PROD],
		});
	});

	it("requires authentication", async () => {
		mocks.getSession.mockResolvedValue(null);
		const result = await verifyAndSaveCredentials("a", "b", "production");
		expect(result).toEqual({
			success: false,
			error: "Authentication required.",
		});
		expect(mocks.discoverAccessibleDomains).not.toHaveBeenCalled();
	});

	it("rejects a blank username / API key before touching HQ", async () => {
		expect(await verifyAndSaveCredentials("  ", "key", "production")).toEqual({
			success: false,
			error: "Username is required.",
		});
		expect(await verifyAndSaveCredentials("alice", "  ", "production")).toEqual(
			{
				success: false,
				error: "API key is required.",
			},
		);
		expect(mocks.discoverAccessibleDomains).not.toHaveBeenCalled();
	});

	it("rejects a server outside the closed catalog before touching HQ", async () => {
		const result = await verifyAndSaveCredentials(
			"alice",
			"key",
			"https://evil.example.com",
		);
		expect(result).toEqual({
			success: false,
			error: "Pick a CommCare HQ server.",
		});
		expect(mocks.discoverAccessibleDomains).not.toHaveBeenCalled();
		expect(mocks.saveCommCareSettings).not.toHaveBeenCalled();
	});

	it("maps a 401 to a message naming the picked server and does not save", async () => {
		mocks.discoverAccessibleDomains.mockResolvedValue({
			success: false,
			status: 401,
		});
		const result = await verifyAndSaveCredentials("alice", "bad-key", "eu");
		expect(result.success).toBe(false);
		if (!result.success) {
			/* The key may be perfectly valid — on a different deployment. The
			 * message must point at the server choice or the user has nothing
			 * left to check. */
			expect(result.error).toContain("eu.commcarehq.org");
			expect(result.error).toContain("server that issued it");
		}
		expect(mocks.saveCommCareSettings).not.toHaveBeenCalled();
	});

	it("rejects a key that reaches zero spaces", async () => {
		mocks.discoverAccessibleDomains.mockResolvedValue([]);
		const result = await verifyAndSaveCredentials("alice", "key", "production");
		expect(result.success).toBe(false);
		expect(mocks.saveCommCareSettings).not.toHaveBeenCalled();
	});
});

describe("refreshDomainsAction", () => {
	it("returns the refreshed settings on success", async () => {
		const settings = {
			configured: true,
			username: "alice@example.com",
			server: "production",
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

	it("explains a refresh 401 as a no-longer-accepted key, not a copy mistake", async () => {
		mocks.refreshApprovedDomains.mockResolvedValue({
			ok: false,
			kind: "hq_error",
			status: 401,
		});
		const result = await refreshDomainsAction();
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toContain("no longer accepts");
		}
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
