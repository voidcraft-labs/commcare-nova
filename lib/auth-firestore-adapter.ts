/**
 * Compatibility shims that make `better-auth-firestore` satisfy Better Auth
 * core's full adapter contract — both for direct calls and for the calls core
 * makes from inside `adapter.transaction(...)`.
 *
 * The community `better-auth-firestore` adapter implements only a partial
 * transaction surface: the object it hands to a transaction callback exposes
 * `create` / `update` / `findOne` and nothing else. But Better Auth core (≥1.6)
 * increasingly runs its write flows inside `adapter.transaction(cb)` and calls
 * the full method set on the transaction-scoped adapter — `findMany`,
 * `deleteMany`, `updateMany`, `count`, `consumeOne`, `incrementOne`. Any such
 * call throws `r.<method> is not a function` and 500s the request. Two flows
 * hit this in production:
 *   - the database rate limiter's guarded counter bump (`incrementOne`, which
 *     core synthesizes from `findMany` + `updateMany` in a transaction); and
 *   - the OAuth 2.1 token exchange, which consumes the single-use authorization
 *     code via `consumeVerificationValue` → `findMany` + `consumeOne` +
 *     `deleteMany` in a transaction. This is the path that broke Claude Code's
 *     MCP sign-in: `/oauth2/token` 500s with an empty body, surfacing client-
 *     side as "Invalid OAuth error response".
 *
 * Two shims, applied by `withCompleteFirestoreAdapter`, close the whole class
 * rather than one missing method at a time:
 *
 * 1. **Native atomic `incrementOne`.** The guarded compare-and-increment the
 *    rate limiter (per-(IP, path) counter) and the API-key quota path depend
 *    on. Backed by a Firestore transaction: read the row, evaluate the guard
 *    predicates, write the set + incremented values. Firestore's optimistic
 *    concurrency makes the read-modify-write atomic across Cloud Run instances
 *    — the property the `database` rate-limit storage was chosen for, and one a
 *    non-atomic fallback would silently lose under concurrent traffic.
 *
 *    Field names pass through verbatim. The only models that use `incrementOne`
 *    (`rateLimit`, `apikey`) carry no field the Firestore adapter remaps under
 *    the default naming strategy, so the names Better Auth hands us here are
 *    already the stored Firestore field names. Guards are evaluated in JS rather
 *    than pushed into the query so a row matched on its identity field can carry
 *    two range guards at once (e.g. `count < max` AND `lastRequest > windowStart`)
 *    — Firestore forbids inequality filters on more than one field per query.
 *
 * 2. **As-is transactions.** The adapter's native transaction can't serve the
 *    full method set, so we route `adapter.transaction(cb)` through Better
 *    Auth's own documented fallback shape — run `cb` against the complete base
 *    adapter (which implements `findMany` / `deleteMany` / `updateMany` /
 *    `count`, plus the native `incrementOne` above). Every method core reaches
 *    for inside a transaction now resolves, and reads/writes use the adapter's
 *    own model→collection resolution, so they stay consistent with how rows
 *    were written. The cost is group-rollback atomicity for multi-write flows;
 *    Nova's auth surface (Google OAuth + the OAuth provider + API keys) runs no
 *    such flow — the OAuth provider and API-key plugins use no transactions,
 *    and only core's email/password sign-up does, which Nova does not enable.
 *    Single-use of authorization codes is preserved by Better Auth's in-process
 *    verification-consume lock plus PKCE binding, not by transaction isolation.
 */

import type { firestoreAdapter } from "better-auth-firestore";
import type { Firestore as AdminFirestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";

type AdapterFactory = ReturnType<typeof firestoreAdapter>;
type AdapterInstance = ReturnType<AdapterFactory>;
type IncrementOneFn = AdapterInstance["incrementOne"];
type IncrementOneArgs = Parameters<IncrementOneFn>[0];
type WhereClause = IncrementOneArgs["where"][number];

/**
 * Collection-name overrides, mirroring the `firestoreAdapter` config so this
 * extension resolves the same Firestore collection the adapter's own reads and
 * writes use for a given Better Auth model.
 */
export type AuthCollections = {
	users: string;
	sessions: string;
	accounts: string;
	verificationTokens: string;
};

/** Mirror of the adapter's model → collection resolution. */
function collectionFor(
	db: AdminFirestore,
	model: string,
	collections: AuthCollections,
) {
	const normalized = model.toLowerCase().replace(/s$/, "");
	if (normalized === "user") return db.collection(collections.users);
	if (normalized === "session") return db.collection(collections.sessions);
	if (normalized === "account") return db.collection(collections.accounts);
	if (normalized === "verificationtoken")
		return db.collection(collections.verificationTokens);
	return db.collection(model);
}

/** Stored Firestore values, Dates, and numbers, all reduced to one comparable scale. */
function toComparable(value: unknown): unknown {
	if (value instanceof Timestamp) return value.toMillis();
	if (value instanceof Date) return value.getTime();
	return value;
}

function matchesCondition(
	row: Record<string, unknown>,
	{ field, value, operator }: WhereClause,
): boolean {
	const actual = row[field];
	switch (operator ?? "eq") {
		case "eq":
			if (value === null || value === undefined) return actual == null;
			if (
				value instanceof Date ||
				actual instanceof Date ||
				actual instanceof Timestamp
			)
				return toComparable(actual) === toComparable(value);
			return actual === value;
		case "ne":
			return actual !== value;
		case "lt":
			return (toComparable(actual) as number) < (toComparable(value) as number);
		case "lte":
			return (
				(toComparable(actual) as number) <= (toComparable(value) as number)
			);
		case "gt":
			return (toComparable(actual) as number) > (toComparable(value) as number);
		case "gte":
			return (
				(toComparable(actual) as number) >= (toComparable(value) as number)
			);
		default:
			throw new Error(
				`Firestore incrementOne does not support the "${operator}" operator (field "${field}"). ` +
					`Supported guards: eq, ne, lt, lte, gt, gte.`,
			);
	}
}

/** True when `row` satisfies every (AND-joined) guard. Exported for testing. */
export function rowMatchesWhere(
	row: Record<string, unknown>,
	where: WhereClause[],
): boolean {
	return where.every((condition) => matchesCondition(row, condition));
}

/**
 * The values to persist: `set` applied first, then each `increment` field set
 * to its current numeric value plus the delta (a missing/non-numeric field
 * counts as 0). Increment wins over `set` for the same field, matching Better
 * Auth core's own fallback. Exported for testing.
 */
export function nextValues(
	row: Record<string, unknown>,
	increment: Record<string, number>,
	set: Record<string, unknown>,
): Record<string, unknown> {
	const values: Record<string, unknown> = { ...set };
	for (const [field, delta] of Object.entries(increment)) {
		const current = typeof row[field] === "number" ? (row[field] as number) : 0;
		values[field] = current + delta;
	}
	return values;
}

/** Dates → Firestore Timestamps for the write; everything else untouched. */
function toFirestoreWrite(
	values: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [field, value] of Object.entries(values)) {
		out[field] = value instanceof Date ? Timestamp.fromDate(value) : value;
	}
	return out;
}

/** Firestore Timestamps → Dates so the returned row reads at the app level. */
function toAppRow(data: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [field, value] of Object.entries(data)) {
		out[field] = value instanceof Timestamp ? value.toDate() : value;
	}
	return out;
}

function makeIncrementOne(
	db: AdminFirestore,
	collections: AuthCollections,
): IncrementOneFn {
	const incrementOne = async ({
		model,
		where,
		increment,
		set,
	}: IncrementOneArgs): Promise<Record<string, unknown> | null> => {
		const col = collectionFor(db, model, collections);
		return db.runTransaction(async (tx) => {
			/* Locate the target row by its identity condition. `id` is the
			 * document id (not a stored field), so it addresses a doc directly;
			 * any other model uses a unique equality field (the rate limiter's
			 * `key`). Remaining conditions are guards, checked in JS below. */
			const idCondition = where.find((c) => c.field === "id");
			let docRef: FirebaseFirestore.DocumentReference | undefined;
			let stored: Record<string, unknown> | undefined;
			if (
				idCondition &&
				(idCondition.operator ?? "eq") === "eq" &&
				typeof idCondition.value === "string"
			) {
				docRef = col.doc(idCondition.value);
				const doc = await tx.get(docRef);
				stored = doc.exists ? doc.data() : undefined;
			} else {
				const identity = where.find(
					(c) => c.field !== "id" && (c.operator ?? "eq") === "eq",
				);
				if (!identity)
					throw new Error(
						`Firestore incrementOne needs an equality condition to locate the row (model "${model}").`,
					);
				const snap = await tx.get(
					col.where(identity.field, "==", identity.value).limit(1),
				);
				const doc = snap.docs[0];
				docRef = doc?.ref;
				stored = doc?.data();
			}
			if (!docRef || !stored) return null;

			/* Surface the document id as the `id` field so guards on it resolve,
			 * then enforce every guard. A miss means another writer moved the row
			 * out from under the guard — the caller treats null as "retry". */
			const row = { id: docRef.id, ...stored };
			if (!rowMatchesWhere(row, where)) return null;

			const values = nextValues(stored, increment, set ?? {});
			tx.update(docRef, toFirestoreWrite(values));
			return { ...toAppRow(row), ...values };
		});
	};
	/* The adapter contract types `incrementOne` with a generic return; this impl
	 * returns the concrete row it wrote, so bridge the two here. */
	return incrementOne as IncrementOneFn;
}

/**
 * Wraps a `firestoreAdapter` factory so the adapter Better Auth builds meets
 * core's full method contract — see this module's header for the two shims.
 *
 * Ordering is load-bearing: `incrementOne` is installed first so the as-is
 * `transaction` closure, which captures `adapter` by reference, hands the
 * patched adapter (native atomic `incrementOne` included) to every transaction
 * callback. `getCurrentAdapter()` resolves the same object, so a method called
 * via `trx` inside a transaction is the identical implementation as the direct
 * call.
 */
export function withCompleteFirestoreAdapter(
	factory: AdapterFactory,
	db: AdminFirestore,
	collections: AuthCollections,
): AdapterFactory {
	return (options) => {
		const adapter = factory(options);
		adapter.incrementOne = makeIncrementOne(db, collections);
		/* Run transaction callbacks against the complete base adapter. The
		 * adapter's native transaction exposes only create/update/findOne, so
		 * core's transaction-scoped findMany/deleteMany/updateMany/count/
		 * consumeOne calls would throw; this is Better Auth's documented
		 * as-is fallback (`createAsIsTransaction`), made explicit because the
		 * adapter advertises a transaction the framework would otherwise trust. */
		adapter.transaction = ((run) =>
			run(adapter)) as AdapterInstance["transaction"];
		return adapter;
	};
}
