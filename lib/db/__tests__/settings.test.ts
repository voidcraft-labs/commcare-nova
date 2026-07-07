/**
 * Unit tests for the wiring inside `lib/db/settings.ts` that the layers above
 * mock away — specifically the security-critical decrypt ordering in
 * `getCredentialsForUpload`.
 *
 * The MCP tool and Server Action tests mock `getCredentialsForUpload`
 * wholesale, so they can't catch a regression that decrypts a key before the
 * upload target resolves (a KMS call on a doomed request). These tests exercise
 * the real wiring with only the Firestore + KMS boundaries mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted boundary mocks ──────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	settingsGet: vi.fn(),
	settingsSet: vi.fn(),
	decrypt: vi.fn(),
	discover: vi.fn(),
}));

/* settings.ts reads through `docs.settings(userId).get()` and writes through
 * `.set()`; we stub both so a test can pin the read snapshot and assert
 * whether a write happened. */
vi.mock("@/lib/db/firestore", () => ({
	docs: {
		settings: () => ({ get: mocks.settingsGet, set: mocks.settingsSet }),
	},
}));
vi.mock("@/lib/commcare/encryption", () => ({
	decrypt: mocks.decrypt,
	encrypt: vi.fn(),
}));
vi.mock("@/lib/commcare/client", () => ({
	discoverAccessibleDomains: mocks.discover,
}));

import { Timestamp } from "@google-cloud/firestore";
import { getCredentialsForUpload, refreshApprovedDomains } from "../settings";
import { userSettingsDocSchema } from "../types";

const PROD = { name: "connect-ace-prod", displayName: "ACE Prod" };
const CRISPR = { name: "ace-crispr-connect", displayName: "CRISPR" };

/** Firestore snapshot stand-in for an existing doc with the given fields. */
function snap(data: Record<string, unknown>) {
	return { exists: true, data: () => data };
}

beforeEach(() => {
	mocks.settingsGet.mockReset();
	mocks.settingsSet.mockReset();
	mocks.decrypt.mockReset();
	mocks.discover.mockReset();
	mocks.decrypt.mockResolvedValue("plaintext-key");
});

describe("getCredentialsForUpload — decrypt happens ONLY after the target resolves", () => {
	it("single-space key, no request → ok, decrypts exactly once", async () => {
		mocks.settingsGet.mockResolvedValue(
			snap({
				commcare_username: "alice@example.com",
				commcare_api_key: "ciphertext",
				commcare_server: "eu",
				approved_domains: [PROD],
			}),
		);
		const r = await getCredentialsForUpload("u1");
		expect(r).toEqual({
			ok: true,
			creds: {
				username: "alice@example.com",
				apiKey: "plaintext-key",
				server: "eu",
			},
			domain: PROD,
		});
		expect(mocks.decrypt).toHaveBeenCalledTimes(1);
	});

	it("multi-space key, no request, no default → ambiguous, NEVER decrypts", async () => {
		mocks.settingsGet.mockResolvedValue(
			snap({
				commcare_username: "alice@example.com",
				commcare_api_key: "ciphertext",
				commcare_server: "production",
				approved_domains: [PROD, CRISPR],
			}),
		);
		const r = await getCredentialsForUpload("u1");
		expect(r).toEqual({
			ok: false,
			error: "ambiguous",
			available: [PROD, CRISPR],
		});
		expect(mocks.decrypt).not.toHaveBeenCalled();
	});

	it("requested space unreachable → not_authorized, NEVER decrypts", async () => {
		mocks.settingsGet.mockResolvedValue(
			snap({
				commcare_username: "alice@example.com",
				commcare_api_key: "ciphertext",
				commcare_server: "production",
				approved_domains: [PROD, CRISPR],
			}),
		);
		const r = await getCredentialsForUpload("u1", "ghost-space");
		expect(r).toEqual({
			ok: false,
			error: "not_authorized",
			available: [PROD, CRISPR],
		});
		expect(mocks.decrypt).not.toHaveBeenCalled();
	});

	it("an explicit reachable request resolves on a multi-space key", async () => {
		mocks.settingsGet.mockResolvedValue(
			snap({
				commcare_username: "alice@example.com",
				commcare_api_key: "ciphertext",
				commcare_server: "production",
				approved_domains: [PROD, CRISPR],
			}),
		);
		const r = await getCredentialsForUpload("u1", "connect-ace-prod");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.domain).toEqual(PROD);
		expect(mocks.decrypt).toHaveBeenCalledTimes(1);
	});

	it("no settings doc → not_configured, NEVER decrypts", async () => {
		mocks.settingsGet.mockResolvedValue({
			exists: false,
			data: () => undefined,
		});
		const r = await getCredentialsForUpload("u1");
		expect(r).toEqual({ ok: false, error: "not_configured" });
		expect(mocks.decrypt).not.toHaveBeenCalled();
	});

	it("configured row with zero stored spaces → not_configured", async () => {
		mocks.settingsGet.mockResolvedValue(
			snap({
				commcare_username: "alice@example.com",
				commcare_api_key: "ciphertext",
				commcare_server: "production",
				approved_domains: [],
			}),
		);
		const r = await getCredentialsForUpload("u1");
		expect(r).toEqual({ ok: false, error: "not_configured" });
		expect(mocks.decrypt).not.toHaveBeenCalled();
	});

	it("row without commcare_server (pre-migration) → not_configured, NEVER decrypts", async () => {
		/* The defensive collapse mirrors the username/spaces one: a row the
		 * `migrate-commcare-server.ts` backfill hasn't touched must read as
		 * unconfigured rather than produce credentials with no server to
		 * derive a base URL from. (This mock bypasses the Zod converter; the
		 * schema suite below proves the converter parses such a row instead
		 * of throwing, so this reader-level collapse is actually reachable.) */
		mocks.settingsGet.mockResolvedValue(
			snap({
				commcare_username: "alice@example.com",
				commcare_api_key: "ciphertext",
				approved_domains: [PROD],
			}),
		);
		const r = await getCredentialsForUpload("u1");
		expect(r).toEqual({ ok: false, error: "not_configured" });
		expect(mocks.decrypt).not.toHaveBeenCalled();
	});
});

describe("refreshApprovedDomains — never clobbers stored spaces on a non-success", () => {
	const configuredRow = snap({
		commcare_username: "alice@example.com",
		commcare_api_key: "ciphertext",
		commcare_server: "production",
		approved_domains: [PROD],
	});

	it("an empty-but-successful probe returns no_spaces and writes NOTHING", async () => {
		mocks.settingsGet.mockResolvedValue(configuredRow);
		/* A transient all-401 probe (key access revoked / blipped) yields an
		 * empty set with no error — the exact case that previously zeroed the
		 * stored row and silently flipped the user to "not configured." */
		mocks.discover.mockResolvedValue([]);

		const result = await refreshApprovedDomains("u1");

		expect(result).toEqual({ ok: false, kind: "no_spaces" });
		/* The load-bearing assertion: the stored row is untouched. */
		expect(mocks.settingsSet).not.toHaveBeenCalled();
	});

	it("an HQ API error returns hq_error and writes NOTHING", async () => {
		mocks.settingsGet.mockResolvedValue(configuredRow);
		mocks.discover.mockResolvedValue({ success: false, status: 503 });

		const result = await refreshApprovedDomains("u1");

		expect(result).toEqual({ ok: false, kind: "hq_error", status: 503 });
		expect(mocks.settingsSet).not.toHaveBeenCalled();
	});

	it("reads back unconfigured (no write) when no key is stored", async () => {
		mocks.settingsGet.mockResolvedValue({
			exists: false,
			data: () => undefined,
		});

		const result = await refreshApprovedDomains("u1");

		expect(result).toEqual({ ok: true, settings: { configured: false } });
		expect(mocks.discover).not.toHaveBeenCalled();
		expect(mocks.settingsSet).not.toHaveBeenCalled();
	});
});

describe("userSettingsDocSchema — the converter tolerates pre-migration rows", () => {
	/* Real reads go through `zodConverter(userSettingsDocSchema)` — a throw
	 * here 500s every surface that touches settings (the settings page, the
	 * builder page, MCP, uploads). A row written before `commcare_server`
	 * existed must PARSE (and then collapse to not-configured in the readers
	 * above), not throw. */
	const preMigrationRow = {
		commcare_username: "alice@example.com",
		commcare_api_key: "ciphertext",
		approved_domains: [PROD],
		updated_at: Timestamp.now(),
	};

	it("parses a row without commcare_server", () => {
		const parsed = userSettingsDocSchema.parse(preMigrationRow);
		expect(parsed.commcare_server).toBeUndefined();
	});

	it("rejects a server value outside the closed catalog", () => {
		expect(() =>
			userSettingsDocSchema.parse({
				...preMigrationRow,
				commcare_server: "staging",
			}),
		).toThrow();
	});

	it("parses a fully-migrated row with its server intact", () => {
		const parsed = userSettingsDocSchema.parse({
			...preMigrationRow,
			commcare_server: "eu",
		});
		expect(parsed.commcare_server).toBe("eu");
	});
});
