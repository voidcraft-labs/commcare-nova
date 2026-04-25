/**
 * Unit tests for `lib/db/oauth-consents.ts`. The Firestore admin SDK
 * is mocked at the `getDb()` boundary; the fakes track every `where`
 * / `limit` call so assertions can pin the field names and filter
 * shape Firestore actually has to satisfy.
 */

import { Timestamp } from "@google-cloud/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mock registry ───────────────────────────────────────────

/**
 * `vi.mock` factories run before imports, so the state they capture
 * must exist at hoist time. `vi.hoisted` lifts the registry alongside.
 * Reset between tests via `beforeEach`.
 */
const mocks = vi.hoisted(() => {
	type CollectionKey = string;

	interface FakeDocSnap {
		id: string;
		exists: boolean;
		data: () => unknown;
		ref: { id: string; collectionPath: string };
	}

	interface FakeQuerySnap {
		empty: boolean;
		docs: FakeDocSnap[];
	}

	/**
	 * Stand-in for Firestore's CollectionReference: tracks every `where`
	 * / `limit` call for assertions and exposes `doc(id)` because the
	 * production helper uses `.doc(consentId)` for txn refs.
	 */
	interface FakeDocRef {
		id: string;
		collectionPath: string;
		delete?: () => Promise<void>;
	}

	interface FakeCollection {
		whereCalls: Array<[string, string, unknown]>;
		limitCalls: number[];
		where: (field: string, op: string, value: unknown) => FakeCollection;
		limit: (n: number) => FakeCollection;
		get: () => Promise<FakeQuerySnap>;
		doc: (id: string) => FakeDocRef;
		_snap: FakeQuerySnap;
		_path: string;
	}

	function makeQuerySnap(docs: FakeDocSnap[]): FakeQuerySnap {
		return { empty: docs.length === 0, docs };
	}

	function makeCollection(path: string, snap: FakeQuerySnap): FakeCollection {
		const c: FakeCollection = {
			whereCalls: [],
			limitCalls: [],
			where: (field, op, value) => {
				c.whereCalls.push([field, op, value]);
				return c;
			},
			limit: (n) => {
				c.limitCalls.push(n);
				return c;
			},
			get: vi.fn(async () => snap),
			doc: (id) => ({ id, collectionPath: path }),
			_snap: snap,
			_path: path,
		};
		return c;
	}

	/** Per-collection state — the test seeds these. */
	const collectionState = new Map<CollectionKey, FakeCollection>();

	const collection = vi.fn((name: CollectionKey) => {
		const existing = collectionState.get(name);
		if (existing) return existing;
		const fresh = makeCollection(name, makeQuerySnap([]));
		collectionState.set(name, fresh);
		return fresh;
	});

	const runTransaction = vi.fn();

	function setCollection(name: CollectionKey, docs: FakeDocSnap[]) {
		collectionState.set(name, makeCollection(name, makeQuerySnap(docs)));
	}

	function getCollection(name: CollectionKey): FakeCollection {
		const c = collectionState.get(name);
		if (!c) throw new Error(`No fake collection seeded for "${name}"`);
		return c;
	}

	function reset() {
		collectionState.clear();
		collection.mockClear();
		runTransaction.mockReset();
	}

	const getDb = vi.fn(() => ({
		collection,
		runTransaction,
	}));

	return {
		getDb,
		collection,
		runTransaction,
		setCollection,
		getCollection,
		makeDocSnap: (
			id: string,
			data: unknown,
			collectionPath: string,
		): FakeDocSnap => ({
			id,
			exists: true,
			data: () => data,
			ref: { id, collectionPath, delete: vi.fn(async () => {}) },
		}),
		reset,
	};
});

vi.mock("../firestore", () => ({
	getDb: mocks.getDb,
}));

// ── Test setup ──────────────────────────────────────────────────────

beforeEach(() => {
	mocks.reset();
});

// ── listAuthorizedClients ───────────────────────────────────────────

describe("listAuthorizedClients", () => {
	it("returns an empty array when the user has no consents", async () => {
		mocks.setCollection("oauthConsent", []);

		const { listAuthorizedClients } = await import("../oauth-consents");
		const rows = await listAuthorizedClients("user-1");

		expect(rows).toEqual([]);
	});

	it("joins consent + client, sorts by authorizedAt desc, and uses 'An application' fallback when client_name is missing", async () => {
		const olderConsent = mocks.makeDocSnap(
			"consent-old",
			{
				userId: "user-1",
				clientId: "client-A",
				scopes: ["nova.read", "nova.write"],
				createdAt: Timestamp.fromDate(new Date("2026-04-10T12:00:00Z")),
			},
			"oauthConsent",
		);
		const newerConsent = mocks.makeDocSnap(
			"consent-new",
			{
				userId: "user-1",
				clientId: "client-B",
				scopes: ["nova.read"],
				createdAt: Timestamp.fromDate(new Date("2026-04-22T12:00:00Z")),
			},
			"oauthConsent",
		);
		mocks.setCollection("oauthConsent", [olderConsent, newerConsent]);

		mocks.setCollection("oauthClient", [
			/* Storage-shape field names (camelCase), not RFC 7591 wire. */
			mocks.makeDocSnap(
				"oauthClient/internal-id-A",
				{ clientId: "client-A", name: "Claude Code" },
				"oauthClient",
			),
			/* client-B has no `name` → falls back to "An application". */
			mocks.makeDocSnap(
				"oauthClient/internal-id-B",
				{ clientId: "client-B" },
				"oauthClient",
			),
		]);

		const { listAuthorizedClients } = await import("../oauth-consents");
		const rows = await listAuthorizedClients("user-1");

		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			consentId: "consent-new",
			clientId: "client-B",
			clientName: "An application",
			scopes: ["nova.read"],
		});
		expect(rows[1]).toMatchObject({
			consentId: "consent-old",
			clientId: "client-A",
			clientName: "Claude Code",
			scopes: ["nova.read", "nova.write"],
		});
		expect(rows[0].authorizedAt).toBe("2026-04-22T12:00:00.000Z");
		expect(rows[1].authorizedAt).toBe("2026-04-10T12:00:00.000Z");

		const consentQuery = mocks.getCollection("oauthConsent");
		expect(consentQuery.whereCalls).toEqual([["userId", "==", "user-1"]]);

		/* Single `in`-query over the deduped clientIds proves no N+1.
		 * `clientId` (storage name), not `client_id` (wire name). */
		const clientQuery = mocks.getCollection("oauthClient");
		expect(clientQuery.whereCalls).toHaveLength(1);
		const [field, op, value] = clientQuery.whereCalls[0];
		expect(field).toBe("clientId");
		expect(op).toBe("in");
		expect((value as string[]).slice().sort()).toEqual([
			"client-A",
			"client-B",
		]);
	});

	it("dedupes duplicate client_ids in the join query (multiple consents for the same client)", async () => {
		/* The plugin keys consent uniqueness on (userId, clientId,
		 * referenceId), so a single client can produce multiple consent
		 * rows when `referenceId` differs. The `in`-query must dedupe. */
		const c1 = mocks.makeDocSnap(
			"consent-1",
			{
				userId: "user-1",
				clientId: "client-A",
				scopes: ["nova.read"],
				createdAt: Timestamp.fromDate(new Date("2026-04-10T12:00:00Z")),
			},
			"oauthConsent",
		);
		const c2 = mocks.makeDocSnap(
			"consent-2",
			{
				userId: "user-1",
				clientId: "client-A",
				scopes: ["nova.read", "nova.write"],
				createdAt: Timestamp.fromDate(new Date("2026-04-22T12:00:00Z")),
			},
			"oauthConsent",
		);
		mocks.setCollection("oauthConsent", [c1, c2]);
		mocks.setCollection("oauthClient", [
			mocks.makeDocSnap(
				"oauthClient/internal-id-A",
				{ clientId: "client-A", name: "Claude Code" },
				"oauthClient",
			),
		]);

		const { listAuthorizedClients } = await import("../oauth-consents");
		await listAuthorizedClients("user-1");

		const clientQuery = mocks.getCollection("oauthClient");
		const [, , value] = clientQuery.whereCalls[0];
		expect(value).toEqual(["client-A"]);
	});
});

// ── hasActiveConsent ────────────────────────────────────────────────

describe("hasActiveConsent", () => {
	it("returns false when no consent exists for (userId, clientId)", async () => {
		mocks.setCollection("oauthConsent", []);

		const { hasActiveConsent } = await import("../oauth-consents");
		const result = await hasActiveConsent("user-1", "client-X");

		expect(result).toBe(false);

		/* Pin the two-equality + limit shape — Firestore satisfies
		 * this from automatic single-field indexes. */
		const q = mocks.getCollection("oauthConsent");
		expect(q.whereCalls).toEqual([
			["userId", "==", "user-1"],
			["clientId", "==", "client-X"],
		]);
		expect(q.limitCalls).toEqual([1]);
	});

	it("returns true when a row matches", async () => {
		mocks.setCollection("oauthConsent", [
			mocks.makeDocSnap(
				"consent-1",
				{
					userId: "user-1",
					clientId: "client-A",
					scopes: ["nova.read", "nova.write"],
					createdAt: Timestamp.fromDate(new Date("2026-04-10T12:00:00Z")),
				},
				"oauthConsent",
			),
		]);

		const { hasActiveConsent } = await import("../oauth-consents");
		const result = await hasActiveConsent("user-1", "client-A");

		expect(result).toBe(true);
	});
});

// ── revokeAuthorizedClient ──────────────────────────────────────────

describe("revokeAuthorizedClient", () => {
	/**
	 * In-memory `runTransaction` driver. Captures every `tx.get` /
	 * `tx.delete` / `tx.update` so tests can assert what was written.
	 */
	function setupTxnHarness(opts: {
		consentDoc?: { id: string; data: unknown; ref: { id: string } } | null;
		consentRows?: Array<{
			id: string;
			data: unknown;
			ref: { id: string };
		}>;
		refreshTokens?: Array<{
			id: string;
			data: unknown;
			ref: { id: string };
		}>;
	}) {
		const txDeletes: Array<{ id: string }> = [];
		const txSets: Array<{ id: string; data: unknown; opts?: unknown }> = [];
		const txUpdates: Array<{ id: string; patch: unknown }> = [];

		mocks.runTransaction.mockImplementation(
			async (
				fn: (tx: {
					get: (
						target: unknown,
					) => Promise<
						| { exists: boolean; data?: () => unknown }
						| { docs: Array<{ ref: { id: string }; data: () => unknown }> }
					>;
					delete: (ref: { id: string }) => void;
					set: (ref: { id: string }, data: unknown, opts?: unknown) => void;
					update: (ref: { id: string }, patch: unknown) => void;
				}) => Promise<unknown>,
			) => {
				const tx = {
					get: vi.fn(async (target: unknown) => {
						/* Doc refs have `.id`; Query objects don't. The
						 * production helper passes the consent ref first
						 * then Query objects for consent duplicates and
						 * refresh-token bulk reads. */
						if (
							typeof target === "object" &&
							target !== null &&
							"id" in target
						) {
							const c = opts.consentDoc;
							return c
								? { exists: true, data: () => c.data }
								: { exists: false };
						}
						if (
							typeof target === "object" &&
							target !== null &&
							"_path" in target &&
							target._path === "oauthConsent"
						) {
							const rows =
								opts.consentRows ?? (opts.consentDoc ? [opts.consentDoc] : []);
							return {
								docs: rows.map((t) => ({
									ref: t.ref,
									data: () => t.data,
								})),
							};
						}
						const tokens = opts.refreshTokens ?? [];
						return {
							docs: tokens.map((t) => ({
								ref: t.ref,
								data: () => t.data,
							})),
						};
					}),
					delete: vi.fn((ref: { id: string }) => {
						txDeletes.push({ id: ref.id });
					}),
					set: vi.fn((ref: { id: string }, data: unknown, opts?: unknown) => {
						txSets.push({ id: ref.id, data, opts });
					}),
					update: vi.fn((ref: { id: string }, patch: unknown) => {
						txUpdates.push({ id: ref.id, patch });
					}),
				};
				return await fn(tx);
			},
		);

		return { txDeletes, txSets, txUpdates };
	}

	it("happy path: deletes the consent and revokes every active refresh token in one transaction", async () => {
		const { txDeletes, txUpdates } = setupTxnHarness({
			consentDoc: {
				id: "consent-1",
				data: { userId: "user-1", clientId: "client-A", scopes: [] },
				ref: { id: "consent-1" },
			},
			refreshTokens: [
				{
					id: "token-a",
					data: { userId: "user-1", clientId: "client-A" },
					ref: { id: "token-a" },
				},
				{
					id: "token-b",
					data: { userId: "user-1", clientId: "client-A" },
					ref: { id: "token-b" },
				},
			],
		});

		const { revokeAuthorizedClient } = await import("../oauth-consents");
		await revokeAuthorizedClient("user-1", "consent-1");

		/* Consent doc deleted. */
		expect(txDeletes).toEqual([{ id: "consent-1" }]);

		/* Both refresh tokens marked revoked. The patch shape is checked
		 * loosely — `revoked` must be set, but the exact value is a
		 * FieldValue.serverTimestamp() sentinel so a deep-equal would
		 * be fragile. Pin the property name + presence. */
		expect(txUpdates).toHaveLength(2);
		const ids = txUpdates.map((u) => u.id).sort();
		expect(ids).toEqual(["token-a", "token-b"]);
		for (const u of txUpdates) {
			expect((u.patch as { revoked: unknown }).revoked).toBeDefined();
		}
	});

	it("idempotent: a missing consent (already revoked) is a no-op", async () => {
		const { txDeletes, txUpdates } = setupTxnHarness({
			consentDoc: null,
		});

		const { revokeAuthorizedClient } = await import("../oauth-consents");
		await revokeAuthorizedClient("user-1", "consent-gone");

		expect(txDeletes).toEqual([]);
		expect(txUpdates).toEqual([]);
	});

	it("rejects when the consent belongs to a different user (defense in depth)", async () => {
		setupTxnHarness({
			consentDoc: {
				id: "consent-1",
				data: { userId: "other-user", clientId: "client-A", scopes: [] },
				ref: { id: "consent-1" },
			},
		});

		const { revokeAuthorizedClient } = await import("../oauth-consents");
		await expect(revokeAuthorizedClient("user-1", "consent-1")).rejects.toThrow(
			/does not belong to this user/,
		);
	});

	it("skips refresh tokens that are already revoked (no redundant write)", async () => {
		const { txUpdates } = setupTxnHarness({
			consentDoc: {
				id: "consent-1",
				data: { userId: "user-1", clientId: "client-A", scopes: [] },
				ref: { id: "consent-1" },
			},
			refreshTokens: [
				{
					id: "live",
					data: { userId: "user-1", clientId: "client-A" },
					ref: { id: "live" },
				},
				{
					id: "already-revoked",
					data: {
						userId: "user-1",
						clientId: "client-A",
						revoked: new Date("2026-01-01T00:00:00Z"),
					},
					ref: { id: "already-revoked" },
				},
			],
		});

		const { revokeAuthorizedClient } = await import("../oauth-consents");
		await revokeAuthorizedClient("user-1", "consent-1");

		/* Only the live token gets the update. */
		expect(txUpdates).toHaveLength(1);
		expect(txUpdates[0].id).toBe("live");
	});

	it("deletes every consent row for the user/client and writes a revocation watermark", async () => {
		const { txDeletes, txSets, txUpdates } = setupTxnHarness({
			consentDoc: {
				id: "consent-selected",
				data: { userId: "user-1", clientId: "client-A", scopes: [] },
				ref: { id: "consent-selected" },
			},
			consentRows: [
				{
					id: "consent-selected",
					data: { userId: "user-1", clientId: "client-A", scopes: [] },
					ref: { id: "consent-selected" },
				},
				{
					id: "consent-duplicate",
					data: { userId: "user-1", clientId: "client-A", scopes: [] },
					ref: { id: "consent-duplicate" },
				},
			],
			refreshTokens: [
				{
					id: "token-a",
					data: { userId: "user-1", clientId: "client-A" },
					ref: { id: "token-a" },
				},
			],
		});

		const { revokeAuthorizedClient } = await import("../oauth-consents");
		await revokeAuthorizedClient("user-1", "consent-selected");

		expect(txDeletes.map((d) => d.id).sort()).toEqual([
			"consent-duplicate",
			"consent-selected",
		]);
		expect(txSets).toEqual([
			expect.objectContaining({ id: expect.stringMatching(/^grant-rev-/) }),
		]);
		expect(txUpdates).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "token-a" })]),
		);
	});
});

describe("hasActiveConsent", () => {
	it("rejects a token issued before the user/client revocation watermark", async () => {
		mocks.setCollection("oauthConsent", [
			mocks.makeDocSnap(
				"consent-1",
				{
					userId: "user-1",
					clientId: "client-A",
					scopes: ["nova.read"],
					createdAt: Timestamp.fromDate(new Date("2026-04-01T00:00:00Z")),
				},
				"oauthConsent",
			),
		]);
		mocks.setCollection("oauthGrantRevocation", [
			mocks.makeDocSnap(
				"grant-rev-1",
				{
					userId: "user-1",
					clientId: "client-A",
					revokedAt: Timestamp.fromDate(new Date("2026-04-25T10:00:00Z")),
				},
				"oauthGrantRevocation",
			),
		]);

		const { hasActiveConsent } = await import("../oauth-consents");
		const active = await hasActiveConsent(
			"user-1",
			"client-A",
			Math.floor(new Date("2026-04-25T09:59:59Z").getTime() / 1000),
		);

		expect(active).toBe(false);
	});

	it("accepts a token issued after the last user/client revocation watermark", async () => {
		mocks.setCollection("oauthConsent", [
			mocks.makeDocSnap(
				"consent-1",
				{
					userId: "user-1",
					clientId: "client-A",
					scopes: ["nova.read"],
					createdAt: Timestamp.fromDate(new Date("2026-04-01T00:00:00Z")),
				},
				"oauthConsent",
			),
		]);
		mocks.setCollection("oauthGrantRevocation", [
			mocks.makeDocSnap(
				"grant-rev-1",
				{
					userId: "user-1",
					clientId: "client-A",
					revokedAt: Timestamp.fromDate(new Date("2026-04-25T10:00:00Z")),
				},
				"oauthGrantRevocation",
			),
		]);

		const { hasActiveConsent } = await import("../oauth-consents");
		const active = await hasActiveConsent(
			"user-1",
			"client-A",
			Math.floor(new Date("2026-04-25T10:00:01Z").getTime() / 1000),
		);

		expect(active).toBe(true);
	});
});

describe("cleanupStalePublicOAuthClients", () => {
	it("deletes old unauthenticated public clients that have no consent or refresh tokens", async () => {
		const orphan = mocks.makeDocSnap(
			"internal-orphan",
			{
				clientId: "client-orphan",
				public: true,
				createdAt: Timestamp.fromDate(new Date("2026-03-01T00:00:00Z")),
			},
			"oauthClient",
		);
		mocks.setCollection("oauthClient", [orphan]);
		mocks.setCollection("oauthConsent", []);
		mocks.setCollection("oauthRefreshToken", []);

		const { cleanupStalePublicOAuthClients } = await import(
			"../oauth-consents"
		);
		const deleted = await cleanupStalePublicOAuthClients({
			now: new Date("2026-04-25T00:00:00Z"),
			olderThanDays: 30,
			limit: 20,
		});

		expect(deleted).toBe(1);
		expect(orphan.ref.delete).toHaveBeenCalledTimes(1);
		expect(mocks.getCollection("oauthClient").whereCalls).toEqual([
			["createdAt", "<", new Date("2026-03-26T00:00:00.000Z")],
		]);
	});

	it("keeps old public clients that still have consent", async () => {
		const authorized = mocks.makeDocSnap(
			"internal-authorized",
			{
				clientId: "client-authorized",
				public: true,
				createdAt: Timestamp.fromDate(new Date("2026-03-01T00:00:00Z")),
			},
			"oauthClient",
		);
		mocks.setCollection("oauthClient", [authorized]);
		mocks.setCollection("oauthConsent", [
			mocks.makeDocSnap(
				"consent-1",
				{ clientId: "client-authorized", userId: "user-1", scopes: [] },
				"oauthConsent",
			),
		]);
		mocks.setCollection("oauthRefreshToken", []);

		const { cleanupStalePublicOAuthClients } = await import(
			"../oauth-consents"
		);
		const deleted = await cleanupStalePublicOAuthClients({
			now: new Date("2026-04-25T00:00:00Z"),
			olderThanDays: 30,
			limit: 20,
		});

		expect(deleted).toBe(0);
		expect(authorized.ref.delete).not.toHaveBeenCalled();
	});
});
