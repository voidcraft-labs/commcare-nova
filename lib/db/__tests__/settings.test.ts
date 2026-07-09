/**
 * Tests for the wiring inside `lib/db/settings.ts` that the layers above mock
 * away — specifically the security-critical decrypt ordering in
 * `getCredentialsForUpload` and the never-clobber contract of
 * `refreshApprovedDomains`.
 *
 * The `user_settings` row is a real Postgres row (the per-test DB harness);
 * only the KMS (`@/lib/commcare/encryption`) and HQ (`@/lib/commcare/client`)
 * boundaries are mocked, so the read/resolve/decrypt ordering under test is the
 * real one. The former `userSettingsDocSchema` Zod-parse tests are gone: that
 * schema was the Firestore converter's field guard; on Postgres `commcare_server`
 * is a nullable column and the "pre-migration row reads as not-configured"
 * behavior is the reader's `!data.commcare_server` collapse (pinned below),
 * not a Zod parse.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted boundary mocks (KMS + HQ) ───────────────────────────────

const mocks = vi.hoisted(() => ({
	decrypt: vi.fn(),
	discover: vi.fn(),
}));

vi.mock("@/lib/commcare/encryption", () => ({
	decrypt: mocks.decrypt,
	encrypt: vi.fn(),
}));
vi.mock("@/lib/commcare/client", () => ({
	discoverAccessibleDomains: mocks.discover,
}));

import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("settings_");

const PROD = { name: "connect-ace-prod", displayName: "ACE Prod" };
const CRISPR = { name: "ace-crispr-connect", displayName: "CRISPR" };

/** Seed a `user_settings` row. `server: null` reproduces a pre-migration row. */
async function seedSettings(opts: {
	server?: string | null;
	domains: { name: string; displayName: string }[];
}): Promise<void> {
	await h
		.db()
		.insertInto("user_settings")
		.values({
			user_id: "u1",
			commcare_username: "alice@example.com",
			commcare_api_key: "ciphertext",
			commcare_server: opts.server === undefined ? "production" : opts.server,
			approved_domains: JSON.stringify(opts.domains),
			updated_at: new Date(),
		})
		.execute();
}

/** Read the stored `approved_domains` back (to assert a refresh wrote nothing). */
async function readDomains(): Promise<unknown> {
	const row = await h
		.db()
		.selectFrom("user_settings")
		.select("approved_domains")
		.where("user_id", "=", "u1")
		.executeTakeFirst();
	return row?.approved_domains;
}

beforeEach(() => {
	mocks.decrypt.mockReset();
	mocks.discover.mockReset();
	mocks.decrypt.mockResolvedValue("plaintext-key");
});

describe("getCredentialsForUpload — decrypt happens ONLY after the target resolves", () => {
	it("single-space key, no request → ok, decrypts exactly once", async () => {
		await seedSettings({ server: "eu", domains: [PROD] });
		const { getCredentialsForUpload } = await import("../settings");
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
		await seedSettings({ domains: [PROD, CRISPR] });
		const { getCredentialsForUpload } = await import("../settings");
		const r = await getCredentialsForUpload("u1");
		expect(r).toEqual({
			ok: false,
			error: "ambiguous",
			available: [PROD, CRISPR],
		});
		expect(mocks.decrypt).not.toHaveBeenCalled();
	});

	it("requested space unreachable → not_authorized, NEVER decrypts", async () => {
		await seedSettings({ domains: [PROD, CRISPR] });
		const { getCredentialsForUpload } = await import("../settings");
		const r = await getCredentialsForUpload("u1", "ghost-space");
		expect(r).toEqual({
			ok: false,
			error: "not_authorized",
			available: [PROD, CRISPR],
		});
		expect(mocks.decrypt).not.toHaveBeenCalled();
	});

	it("an explicit reachable request resolves on a multi-space key", async () => {
		await seedSettings({ domains: [PROD, CRISPR] });
		const { getCredentialsForUpload } = await import("../settings");
		const r = await getCredentialsForUpload("u1", "connect-ace-prod");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.domain).toEqual(PROD);
		expect(mocks.decrypt).toHaveBeenCalledTimes(1);
	});

	it("no settings row → not_configured, NEVER decrypts", async () => {
		const { getCredentialsForUpload } = await import("../settings");
		const r = await getCredentialsForUpload("u1");
		expect(r).toEqual({ ok: false, error: "not_configured" });
		expect(mocks.decrypt).not.toHaveBeenCalled();
	});

	it("configured row with zero stored spaces → not_configured", async () => {
		await seedSettings({ domains: [] });
		const { getCredentialsForUpload } = await import("../settings");
		const r = await getCredentialsForUpload("u1");
		expect(r).toEqual({ ok: false, error: "not_configured" });
		expect(mocks.decrypt).not.toHaveBeenCalled();
	});

	it("row without commcare_server (pre-migration) → not_configured, NEVER decrypts", async () => {
		// A null `commcare_server` column is the pre-migration row: the reader
		// collapses it to not-configured rather than producing creds with no
		// server to derive a base URL from.
		await seedSettings({ server: null, domains: [PROD] });
		const { getCredentialsForUpload } = await import("../settings");
		const r = await getCredentialsForUpload("u1");
		expect(r).toEqual({ ok: false, error: "not_configured" });
		expect(mocks.decrypt).not.toHaveBeenCalled();
	});
});

describe("refreshApprovedDomains — never clobbers stored spaces on a non-success", () => {
	it("an empty-but-successful probe returns no_spaces and writes NOTHING", async () => {
		await seedSettings({ domains: [PROD] });
		// A transient all-401 probe yields an empty set with no error — the case
		// that previously zeroed the stored row and flipped the user to "not
		// configured."
		mocks.discover.mockResolvedValue([]);
		const { refreshApprovedDomains } = await import("../settings");

		const result = await refreshApprovedDomains("u1");

		expect(result).toEqual({ ok: false, kind: "no_spaces" });
		// The load-bearing assertion: the stored row is untouched.
		expect(await readDomains()).toEqual([PROD]);
	});

	it("an HQ API error returns hq_error and writes NOTHING", async () => {
		await seedSettings({ domains: [PROD] });
		mocks.discover.mockResolvedValue({ status: 503 });
		const { refreshApprovedDomains } = await import("../settings");

		const result = await refreshApprovedDomains("u1");

		expect(result).toEqual({ ok: false, kind: "hq_error", status: 503 });
		expect(await readDomains()).toEqual([PROD]);
	});

	it("reads back unconfigured (no write) when no key is stored", async () => {
		const { refreshApprovedDomains } = await import("../settings");

		const result = await refreshApprovedDomains("u1");

		expect(result).toEqual({ ok: true, settings: { configured: false } });
		expect(mocks.discover).not.toHaveBeenCalled();
	});

	it("persists the refreshed set on a successful probe", async () => {
		await seedSettings({ server: "eu", domains: [PROD] });
		mocks.discover.mockResolvedValue([PROD, CRISPR]);
		const { refreshApprovedDomains } = await import("../settings");

		const result = await refreshApprovedDomains("u1");

		expect(result).toEqual({
			ok: true,
			settings: {
				configured: true,
				username: "alice@example.com",
				server: "eu",
				availableDomains: [PROD, CRISPR],
			},
		});
		expect(await readDomains()).toEqual([PROD, CRISPR]);
	});
});
