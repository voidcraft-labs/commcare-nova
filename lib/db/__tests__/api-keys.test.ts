/**
 * Unit tests for `lib/db/api-keys.ts`. The Firestore admin SDK is
 * mocked at the `getDb()` boundary; the fakes track every `where`
 * call so assertions can pin the storage field names and filter
 * shapes Firestore actually has to satisfy.
 *
 * Mirror of `lib/db/__tests__/oauth-consents.test.ts` patterns — same
 * hoisted-mock structure, same per-collection fake — extended with a
 * count-aggregation fake for `countUserApiKeys`.
 */

import { Timestamp } from "@google-cloud/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mock registry ───────────────────────────────────────────

const mocks = vi.hoisted(() => {
	type CollectionKey = string;

	interface FakeDocSnap {
		id: string;
		exists: boolean;
		data: () => unknown;
	}

	interface FakeQuerySnap {
		empty: boolean;
		docs: FakeDocSnap[];
	}

	/** Stand-in for Firestore's count aggregation result. */
	interface FakeCountSnap {
		data: () => { count: number };
	}

	interface FakeDocRef {
		get: () => Promise<FakeDocSnap>;
	}

	interface FakeCollection {
		whereCalls: Array<[string, string, unknown]>;
		limitCalls: number[];
		where: (field: string, op: string, value: unknown) => FakeCollection;
		limit: (n: number) => FakeCollection;
		count: () => { get: () => Promise<FakeCountSnap> };
		get: () => Promise<FakeQuerySnap>;
		doc: (id: string) => FakeDocRef;
		_snap: FakeQuerySnap;
		_path: string;
		/** Per-doc-id state for `.doc(id).get()` lookups. */
		_docs: Map<string, FakeDocSnap>;
	}

	function makeQuerySnap(docs: FakeDocSnap[]): FakeQuerySnap {
		return { empty: docs.length === 0, docs };
	}

	function makeMissingDocSnap(): FakeDocSnap {
		return { id: "", exists: false, data: () => ({}) };
	}

	function makeCollection(path: string, snap: FakeQuerySnap): FakeCollection {
		const docMap = new Map<string, FakeDocSnap>();
		for (const d of snap.docs) docMap.set(d.id, d);

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
			count: () => ({
				get: vi.fn(async () => ({ data: () => ({ count: snap.docs.length }) })),
			}),
			get: vi.fn(async () => snap),
			doc: (id) => ({
				get: vi.fn(async () => docMap.get(id) ?? makeMissingDocSnap()),
			}),
			_snap: snap,
			_path: path,
			_docs: docMap,
		};
		return c;
	}

	const collectionState = new Map<CollectionKey, FakeCollection>();

	const collection = vi.fn((name: CollectionKey) => {
		const existing = collectionState.get(name);
		if (existing) return existing;
		const fresh = makeCollection(name, makeQuerySnap([]));
		collectionState.set(name, fresh);
		return fresh;
	});

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
	}

	const getDb = vi.fn(() => ({ collection }));

	return {
		getDb,
		collection,
		setCollection,
		getCollection,
		makeDocSnap: (id: string, data: unknown): FakeDocSnap => ({
			id,
			exists: true,
			data: () => data,
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

// ── listUserApiKeys ─────────────────────────────────────────────────

describe("listUserApiKeys", () => {
	it("returns an empty array when the user has no keys", async () => {
		mocks.setCollection("apikey", []);

		const { listUserApiKeys } = await import("../api-keys");
		const rows = await listUserApiKeys("user-1");

		expect(rows).toEqual([]);
		const query = mocks.getCollection("apikey");
		/* Pins the plugin's storage field name (`referenceId`), not the
		 * surface name (`userId`). A schema-rename regression trips here. */
		expect(query.whereCalls).toEqual([["referenceId", "==", "user-1"]]);
	});

	it("decodes JSON-stringified permissions, surfaces scopes, sorts newest first", async () => {
		const olderKey = mocks.makeDocSnap("key-old", {
			referenceId: "user-1",
			name: "Old key",
			start: "sk-nova-v1-aBc",
			prefix: "sk-nova-v1-",
			createdAt: Timestamp.fromDate(new Date("2026-04-10T12:00:00Z")),
			expiresAt: Timestamp.fromDate(new Date("2027-04-10T12:00:00Z")),
			lastRequest: Timestamp.fromDate(new Date("2026-04-15T08:00:00Z")),
			permissions: JSON.stringify({ scope: ["nova.read", "nova.write"] }),
		});
		const newerKey = mocks.makeDocSnap("key-new", {
			referenceId: "user-1",
			name: "New key",
			start: "sk-nova-v1-XyZ",
			prefix: "sk-nova-v1-",
			createdAt: Timestamp.fromDate(new Date("2026-04-22T12:00:00Z")),
			expiresAt: null,
			lastRequest: null,
			permissions: JSON.stringify({
				scope: ["nova.read", "nova.write", "nova.hq.write"],
			}),
		});
		mocks.setCollection("apikey", [olderKey, newerKey]);

		const { listUserApiKeys } = await import("../api-keys");
		const rows = await listUserApiKeys("user-1");

		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			keyId: "key-new",
			name: "New key",
			displayPrefix: "sk-nova-v1-XyZ",
			scopes: ["nova.read", "nova.write", "nova.hq.write"],
			createdAt: "2026-04-22T12:00:00.000Z",
			expiresAt: null,
			lastUsedAt: null,
		});
		expect(rows[1]).toMatchObject({
			keyId: "key-old",
			displayPrefix: "sk-nova-v1-aBc",
			scopes: ["nova.read", "nova.write"],
			expiresAt: "2027-04-10T12:00:00.000Z",
			lastUsedAt: "2026-04-15T08:00:00.000Z",
		});
	});

	it("handles permissions arriving as a pre-decoded object (defense-in-depth)", async () => {
		/* If the firestore adapter ever changes its serialization (e.g.
		 * starts auto-decoding JSON-strings on read), the helper must
		 * still produce the same surface. This branch documents the
		 * intent so the helper isn't accidentally tightened to
		 * "string-only". */
		const key = mocks.makeDocSnap("key-1", {
			referenceId: "user-1",
			name: "Key",
			start: "sk-nova-v1-abc",
			createdAt: Timestamp.fromDate(new Date("2026-04-22T12:00:00Z")),
			permissions: { scope: ["nova.read", "nova.write"] },
		});
		mocks.setCollection("apikey", [key]);

		const { listUserApiKeys } = await import("../api-keys");
		const rows = await listUserApiKeys("user-1");

		expect(rows[0]?.scopes).toEqual(["nova.read", "nova.write"]);
	});

	it("falls back to an empty scopes array on malformed permissions", async () => {
		const key = mocks.makeDocSnap("key-1", {
			referenceId: "user-1",
			name: "Key",
			start: "sk-nova-v1-abc",
			createdAt: Timestamp.fromDate(new Date("2026-04-22T12:00:00Z")),
			permissions: "not-json-at-all",
		});
		mocks.setCollection("apikey", [key]);

		const { listUserApiKeys } = await import("../api-keys");
		const rows = await listUserApiKeys("user-1");

		expect(rows[0]?.scopes).toEqual([]);
	});

	it("renders displayPrefix as empty string when start is missing (no misleading bare-prefix fallback)", async () => {
		const key = mocks.makeDocSnap("key-1", {
			referenceId: "user-1",
			name: "Key",
			prefix: "sk-nova-v1-",
			createdAt: Timestamp.fromDate(new Date("2026-04-22T12:00:00Z")),
			permissions: JSON.stringify({ scope: ["nova.read", "nova.write"] }),
		});
		mocks.setCollection("apikey", [key]);

		const { listUserApiKeys } = await import("../api-keys");
		const rows = await listUserApiKeys("user-1");

		/* The wire prefix on its own (`sk-nova-v1-`) is meaningless for
		 * row identification — every Nova key starts with it. The
		 * helper returns "" instead so the UI can guard against the
		 * regression, and the `log.warn` (verified in a separate test)
		 * surfaces it in Cloud Logging. */
		expect(rows[0]?.displayPrefix).toBe("");
	});

	it("emits a log.warn when an apikey row is missing the `start` field", async () => {
		const { log } = await import("@/lib/logger");
		const key = mocks.makeDocSnap("key-no-start", {
			referenceId: "user-1",
			name: "Key",
			prefix: "sk-nova-v1-",
			createdAt: Timestamp.fromDate(new Date("2026-04-22T12:00:00Z")),
			permissions: JSON.stringify({ scope: ["nova.read", "nova.write"] }),
		});
		mocks.setCollection("apikey", [key]);

		const { listUserApiKeys } = await import("../api-keys");
		await listUserApiKeys("user-1");

		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining("missing `start`"),
			expect.objectContaining({ keyId: "key-no-start" }),
		);
	});
});

// ── isUserActive ────────────────────────────────────────────────────

describe("isUserActive", () => {
	it("returns true for an existing user with banned=false", async () => {
		mocks.setCollection("auth_users", [
			mocks.makeDocSnap("user-1", { banned: false, email: "u@example.com" }),
		]);

		const { isUserActive } = await import("../api-keys");
		expect(await isUserActive("user-1")).toBe(true);
	});

	it("returns true for an existing user with no `banned` field (treated as not banned)", async () => {
		mocks.setCollection("auth_users", [
			mocks.makeDocSnap("user-1", { email: "u@example.com" }),
		]);

		const { isUserActive } = await import("../api-keys");
		expect(await isUserActive("user-1")).toBe(true);
	});

	it("returns false when the user row is permanently banned (no banExpires)", async () => {
		mocks.setCollection("auth_users", [
			mocks.makeDocSnap("user-1", { banned: true, email: "u@example.com" }),
		]);

		const { isUserActive } = await import("../api-keys");
		expect(await isUserActive("user-1")).toBe(false);
	});

	it("returns false when banned with banExpires still in the future", async () => {
		const future = new Date(Date.now() + 60 * 60 * 1000);
		mocks.setCollection("auth_users", [
			mocks.makeDocSnap("user-1", {
				banned: true,
				banExpires: future,
				email: "u@example.com",
			}),
		]);

		const { isUserActive } = await import("../api-keys");
		expect(await isUserActive("user-1")).toBe(false);
	});

	it("returns true when banned with banExpires already in the past (mirrors admin plugin's lazy-clear)", async () => {
		/* The admin plugin only clears expired bans inside its
		 * session-create hook — api-key verify never goes through
		 * that path, so `isUserActive` replicates the same expiry
		 * semantics inline. Without this branch a temp-banned user's
		 * keys would stay disabled past `banExpires` until they
		 * signed in interactively. */
		const past = new Date(Date.now() - 60 * 60 * 1000);
		mocks.setCollection("auth_users", [
			mocks.makeDocSnap("user-1", {
				banned: true,
				banExpires: past,
				email: "u@example.com",
			}),
		]);

		const { isUserActive } = await import("../api-keys");
		expect(await isUserActive("user-1")).toBe(true);
	});

	it("returns true when banned with banExpires Timestamp already in the past (Firestore-stored shape)", async () => {
		/* Firestore returns `Timestamp` (not `Date`) for stored
		 * datetime fields. The branch that converts via `toMillis()`
		 * needs its own coverage — `instanceof Date` would miss the
		 * Timestamp case and fall through to the
		 * permanent-ban path. */
		const { Timestamp } = await import("@google-cloud/firestore");
		const past = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
		mocks.setCollection("auth_users", [
			mocks.makeDocSnap("user-1", {
				banned: true,
				banExpires: past,
				email: "u@example.com",
			}),
		]);

		const { isUserActive } = await import("../api-keys");
		expect(await isUserActive("user-1")).toBe(true);
	});

	it("returns false when the user row doesn't exist (deleted-account case)", async () => {
		mocks.setCollection("auth_users", []);

		const { isUserActive } = await import("../api-keys");
		expect(await isUserActive("user-deleted")).toBe(false);
	});

	it("propagates Firestore errors (route relies on this for fail-closed posture)", async () => {
		mocks.setCollection("auth_users", []);
		const collection = mocks.getCollection("auth_users");
		/* Force the doc().get() chain to reject — the route's catch
		 * around `isUserActive` returns 401 for the user, which is the
		 * right fail-closed behavior on a transient outage. */
		collection.doc = () => ({
			get: () => Promise.reject(new Error("firestore unavailable")),
		});

		const { isUserActive } = await import("../api-keys");
		await expect(isUserActive("user-1")).rejects.toThrow(
			"firestore unavailable",
		);
	});
});

// ── countUserApiKeys ────────────────────────────────────────────────

describe("countUserApiKeys", () => {
	it("returns the Firestore count aggregation for the user's keys", async () => {
		mocks.setCollection("apikey", [
			mocks.makeDocSnap("k1", { referenceId: "user-1" }),
			mocks.makeDocSnap("k2", { referenceId: "user-1" }),
			mocks.makeDocSnap("k3", { referenceId: "user-1" }),
		]);

		const { countUserApiKeys } = await import("../api-keys");
		const count = await countUserApiKeys("user-1");

		expect(count).toBe(3);
		const query = mocks.getCollection("apikey");
		expect(query.whereCalls).toEqual([["referenceId", "==", "user-1"]]);
	});

	it("returns 0 when the user has no keys", async () => {
		mocks.setCollection("apikey", []);

		const { countUserApiKeys } = await import("../api-keys");
		const count = await countUserApiKeys("user-1");

		expect(count).toBe(0);
	});
});
