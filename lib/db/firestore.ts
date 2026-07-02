/**
 * Firestore client singleton and typed collection helpers.
 *
 * Lazily initialized to avoid import-time crashes in environments where
 * Firestore isn't configured (local dev without emulator, build step).
 *
 * Authentication:
 *   Cloud Run  — Application Default Credentials from the metadata server (automatic).
 *   Local dev  — `gcloud auth application-default login` (one-time setup).
 *   Emulator   — Set FIRESTORE_EMULATOR_HOST=localhost:8080 (SDK handles it natively).
 *
 * The typed collection helpers use Firestore's `withConverter` pattern so
 * reads return validated document types (via Zod schema.parse) and writes
 * accept them (with FieldValue support via WithFieldValue<T>).
 *
 * Document hierarchy:
 *
 *   collections.usage(userId)        → usage/{userId}/months/{yyyy-mm}
 *   collections.creditMonths(userId) → credits/{userId}/months/{yyyy-mm}
 *   collections.creditGrants(userId) → credits/{userId}/grants/{grantId}
 *   collections.apps()               → apps/{appId}          (root-level)
 *   collections.events(appId)        → apps/{appId}/events/{eventId}
 *   collections.runs(appId)          → apps/{appId}/runs/{runId}
 *   collections.threads(appId)       → apps/{appId}/threads/{threadId}
 *   collections.settings()           → user_settings/{userId} (CommCare HQ credentials)
 */
import {
	type CollectionReference,
	type DocumentData,
	type DocumentReference,
	Firestore,
	type FirestoreDataConverter,
	type QueryDocumentSnapshot,
	type Transaction,
	type WithFieldValue,
} from "@google-cloud/firestore";
import type { ZodType } from "zod";
import { type Event, eventSchema } from "@/lib/log/types";
import { log } from "@/lib/logger";
import { delay } from "@/lib/utils/delay";
import { firestoreClientOptions } from "./firestoreClientOptions";
import {
	type AppDoc,
	appDocSchema,
	type CreditGrantDoc,
	type CreditMonthDoc,
	creditGrantDocSchema,
	creditMonthDocSchema,
	type MediaAssetDoc,
	mediaAssetDocSchema,
	type RunSummaryDoc,
	runSummaryDocSchema,
	type ThreadDoc,
	threadDocSchema,
	type UsageDoc,
	type UserSettingsDoc,
	usageDocSchema,
	userSettingsDocSchema,
} from "./types";

// ── Singleton ──────────────────────────────────────────────────────

let _db: Firestore | null = null;

/**
 * Returns the Firestore client singleton, lazily initialized on first call.
 *
 * On Cloud Run, GOOGLE_CLOUD_PROJECT is auto-detected from the metadata server.
 * For local dev, set it in .env or use the Firestore emulator.
 *
 * Throws on first actual Firestore operation (not on construction) if
 * credentials or project ID can't be resolved — callers should handle
 * this at the route level.
 */
export function getDb(): Firestore {
	if (!_db) {
		_db = new Firestore({
			projectId: process.env.GOOGLE_CLOUD_PROJECT,
			...firestoreClientOptions(),
		});
	}
	return _db;
}

// ── Write-throttle ride-out ────────────────────────────────────────

/** gRPC status the write throttle carries on the gRPC transport — the shape
 * the SDK's own retry predicates recognize. */
const GRPC_RESOURCE_EXHAUSTED = 8;

/** HTTP status the same throttle carries on the REST transport. */
const HTTP_TOO_MANY_REQUESTS = 429;

/** Backoff schedule — ~8s across four retries, well under the chat route's
 * ceiling, giving Firestore time to re-allocate write capacity. */
const WRITE_THROTTLE_RETRY_DELAYS_MS = [250, 750, 2000, 5000];

/**
 * Matches Firestore's write throttle on both transports: the gRPC status code
 * (`GoogleError.code`), the REST shape — an HTTP 429 whose `code`/`status`
 * carry the number or its string form — and, as a last resort, an error whose
 * message embeds the 429 response body verbatim.
 */
function isFirestoreWriteThrottled(err: unknown): boolean {
	if (typeof err === "object" && err !== null) {
		const { code, status } = err as { code?: unknown; status?: unknown };
		if (code === GRPC_RESOURCE_EXHAUSTED) return true;
		if (
			code === HTTP_TOO_MANY_REQUESTS ||
			code === String(HTTP_TOO_MANY_REQUESTS) ||
			status === HTTP_TOO_MANY_REQUESTS ||
			status === String(HTTP_TOO_MANY_REQUESTS)
		) {
			return true;
		}
	}
	const message = err instanceof Error ? err.message : String(err);
	return /RESOURCE_EXHAUSTED|maximum bandwidth for writes|rateLimitExceeded/i.test(
		message,
	);
}

/**
 * The shared ride-out loop. `shouldBypass` short-circuits classification for
 * errors the caller KNOWS are not the throttle — a transaction body's own
 * rejection, which can quote user-authored text that would otherwise match
 * the message fallback. Each bounce logs a warning so a shed is never
 * invisible.
 */
async function retryThrottled<T>(
	attemptOnce: () => Promise<T>,
	shouldBypass: (err: unknown) => boolean,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await attemptOnce();
		} catch (err) {
			if (
				shouldBypass(err) ||
				attempt === WRITE_THROTTLE_RETRY_DELAYS_MS.length ||
				!isFirestoreWriteThrottled(err)
			) {
				throw err;
			}
			const delayMs = WRITE_THROTTLE_RETRY_DELAYS_MS[attempt];
			log.warn("[firestore] write throttled; retrying", {
				attempt: attempt + 1,
				delayMs,
				error: err instanceof Error ? err.message.slice(0, 300) : String(err),
			});
			await delay(delayMs);
		}
	}
}

/**
 * Run a Firestore transaction, riding out the write throttle with bounded
 * exponential backoff. Every transaction call site in lib/db goes through
 * this instead of calling `runTransaction` directly.
 *
 * Firestore sheds commits with 429 RESOURCE_EXHAUSTED — "This database has
 * exceeded their maximum bandwidth for writes, please retry with exponential
 * backoff" — and its contract makes the retry the CLIENT's job. The shed is
 * not always explained by the documented limits: this database has rejected
 * single small commits at zero measured load, reads unaffected, with no cause
 * visible on any surface Google exposes — so any 429 commit rejection is
 * weather to ride out.
 *
 * The SDK is built to absorb this itself — RESOURCE_EXHAUSTED is retryable at
 * three layers (the gax call retry, `Firestore._retry`, and the transaction
 * runner) — but all three classify by gRPC status code, and over the REST
 * transport this codebase uses (`preferRest`, see `firestoreClientOptions`)
 * the throttle surfaces as an HTTP error carrying `code: 429`, which none of
 * them match. Unwrapped, a single shed therefore hard-fails the request that
 * carried it.
 *
 * Only TRANSPORT errors are ever classified: an error thrown by the
 * transaction body itself (`OutOfCreditsError`, a commit-gate rejection whose
 * message may quote user-authored text) is recognized by identity and
 * propagates on the first attempt no matter what its message contains.
 * Contention ABORTs are `runTransaction`'s own to retry, and a throttle retry
 * re-runs the whole body — the same re-execution contract the SDK's
 * contention retry already imposes on every body.
 */
export async function runThrottledTransaction<T>(
	db: Firestore,
	updateFunction: (tx: Transaction) => Promise<T>,
): Promise<T> {
	let bodyError: unknown;
	return retryThrottled(
		() => {
			bodyError = undefined;
			return db.runTransaction(async (tx) => {
				try {
					return await updateFunction(tx);
				} catch (err) {
					bodyError = err;
					throw err;
				}
			});
		},
		(err) => bodyError !== undefined && err === bodyError,
	);
}

/**
 * `runThrottledTransaction`'s sibling for PLAIN writes (a bare
 * `set`/`update`/`create`), for the hot paths where a single shed must not
 * fail the user's save (app creation, blueprint snapshots). A plain write's
 * rejection can only come from the SDK — there is no body to misread — so the
 * classifier applies directly. Ops must be idempotent under re-execution;
 * lib/db's plain writes are (full-doc sets and fixed-field updates).
 */
export function runThrottledWrite<T>(op: () => Promise<T>): Promise<T> {
	return retryThrottled(op, () => false);
}

// ── Converters ─────────────────────────────────────────────────────

/**
 * Creates a Firestore data converter backed by a Zod schema.
 *
 * Writes pass through to Firestore unchanged — FieldValue instances
 * (serverTimestamp, increment, etc.) are resolved server-side.
 *
 * Reads are validated through schema.parse(), catching data corruption
 * or schema drift instead of silently returning malformed objects.
 * Zod defaults (e.g. `.default(0)`, `.default('user')`) fill missing
 * fields automatically — no manual null-coalescing in converters.
 */
function zodConverter<T>(schema: ZodType<T>): FirestoreDataConverter<T> {
	/*
	 * Cast required because FirestoreDataConverter has two toFirestore overloads
	 * (full write + merge write) that can't both be satisfied by a single arrow
	 * function signature. The runtime behavior is correct — data passes through
	 * as DocumentData, and the SDK handles FieldValue resolution.
	 */
	return {
		toFirestore: (data: WithFieldValue<T>) => data as unknown as DocumentData,
		fromFirestore: (snapshot: QueryDocumentSnapshot) =>
			schema.parse(snapshot.data()),
	} as FirestoreDataConverter<T>;
}

const usageConverter = zodConverter(usageDocSchema);
const creditMonthConverter = zodConverter(creditMonthDocSchema);
const creditGrantConverter = zodConverter(creditGrantDocSchema);
const appConverter = zodConverter(appDocSchema);
const eventConverter = zodConverter(eventSchema);
const runSummaryConverter = zodConverter(runSummaryDocSchema);
const threadConverter = zodConverter(threadDocSchema);
const userSettingsConverter = zodConverter(userSettingsDocSchema);
const mediaAssetConverter = zodConverter(mediaAssetDocSchema);

// ── Collection Helpers ─────────────────────────────────────────────

/**
 * Typed collection references for each document type.
 *
 * Returns a CollectionReference with the Zod converter applied, so reads
 * are validated and writes accept `WithFieldValue<T>` (allows `FieldValue`
 * sentinels like `serverTimestamp()` in place of their resolved types).
 *
 * Apps are a root-level collection — no parent ID needed.
 * Events and runs are subcollections of their app document.
 * Usage is a root-level collection keyed by userId with a months subcollection.
 *
 * Usage:
 *   const apps = await collections.apps().where('owner', '==', userId).get()
 *   apps.docs.forEach(doc => doc.data())  // → AppDoc (validated)
 */
export const collections = {
	/** Per-user monthly usage: `usage/{userId}/months/{yyyy-mm}` */
	usage: (userId: string): CollectionReference<UsageDoc> =>
		getDb()
			.collection("usage")
			.doc(userId)
			.collection("months")
			.withConverter(usageConverter),

	/** Per-user monthly credit balance: `credits/{userId}/months/{yyyy-mm}` */
	creditMonths: (userId: string): CollectionReference<CreditMonthDoc> =>
		getDb()
			.collection("credits")
			.doc(userId)
			.collection("months")
			.withConverter(creditMonthConverter),

	/** Per-user append-only credit audit: `credits/{userId}/grants/{grantId}` */
	creditGrants: (userId: string): CollectionReference<CreditGrantDoc> =>
		getDb()
			.collection("credits")
			.doc(userId)
			.collection("grants")
			.withConverter(creditGrantConverter),

	/** Root-level apps collection: `apps/{appId}` */
	apps: (): CollectionReference<AppDoc> =>
		getDb().collection("apps").withConverter(appConverter),

	/** Per-app event stream: `apps/{appId}/events/{eventId}` */
	events: (appId: string): CollectionReference<Event> =>
		getDb()
			.collection("apps")
			.doc(appId)
			.collection("events")
			.withConverter(eventConverter),

	/** Per-app per-run summaries: `apps/{appId}/runs/{runId}` */
	runs: (appId: string): CollectionReference<RunSummaryDoc> =>
		getDb()
			.collection("apps")
			.doc(appId)
			.collection("runs")
			.withConverter(runSummaryConverter),

	/** Per-app chat threads: `apps/{appId}/threads/{threadId}` */
	threads: (appId: string): CollectionReference<ThreadDoc> =>
		getDb()
			.collection("apps")
			.doc(appId)
			.collection("threads")
			.withConverter(threadConverter),

	/** User settings: `user_settings/{userId}` (single doc per user) */
	settings: (): CollectionReference<UserSettingsDoc> =>
		getDb().collection("user_settings").withConverter(userSettingsConverter),

	/**
	 * Root-level media assets: `mediaAssets/{assetId}`.
	 *
	 * Root collection rather than per-app subcollection because
	 * dedup follows the owner: a logo reused across three apps is
	 * one row, not three. The library picker shows the owner's
	 * entire asset set in one query; per-app scoping would force
	 * collection-group queries.
	 */
	mediaAssets: (): CollectionReference<MediaAssetDoc> =>
		getDb().collection("mediaAssets").withConverter(mediaAssetConverter),
};

// ── Document Helpers ───────────────────────────────────────────────

/**
 * Typed document references for direct lookups by ID.
 *
 * Useful when you know the exact document path and want a single read
 * or write without querying the collection.
 *
 * Usage:
 *   const snap = await docs.app('abc123').get()
 *   if (snap.exists) console.log(snap.data()!.app_name)  // → string (validated)
 */
export const docs = {
	/** Direct reference: `usage/{userId}/months/{yyyy-mm}` */
	usage: (userId: string, period: string): DocumentReference<UsageDoc> =>
		collections.usage(userId).doc(period),

	/** Direct reference: `credits/{userId}/months/{yyyy-mm}` (converter-applied, for reads). */
	creditMonth: (
		userId: string,
		period: string,
	): DocumentReference<CreditMonthDoc> =>
		collections.creditMonths(userId).doc(period),

	/**
	 * RAW (converter-less) reference to the credit-month doc, for the reservation
	 * transaction. A `withConverter` `tx.get()` routes the snapshot through
	 * `schema.parse`, which throws on a partially-initialized existing doc inside
	 * the transaction (the same parse-on-read hazard `writeRunSummary` guards
	 * against). The reservation reads raw data, supplies the missing-doc defaults
	 * in code, and writes back through a merge — so it must read off the raw ref.
	 *
	 * `withConverter(null)` strips the converter from the same path
	 * `collections.creditMonths` owns, so the credit-month path is single-sourced
	 * (no re-hardcoded `collection(...).doc(...)` chain to drift).
	 */
	creditMonthRaw: (userId: string, period: string): DocumentReference =>
		collections.creditMonths(userId).doc(period).withConverter(null),

	/** Direct reference: `apps/{appId}` */
	app: (appId: string): DocumentReference<AppDoc> =>
		collections.apps().doc(appId),

	/**
	 * RAW (converter-less) reference to an app doc, for transactions that read or
	 * write the credit-reservation marker. A `withConverter` `tx.get()` parses the
	 * snapshot through `appDocSchema`, which throws inside a transaction on any
	 * partial or legacy doc; the reservation reconciliation reads raw data and
	 * merges back, exactly as the credit-month reservation does over
	 * `creditMonthRaw`. Single-sources the app path off `collections.apps`.
	 */
	appRaw: (appId: string): DocumentReference =>
		collections.apps().doc(appId).withConverter(null),

	/** Direct reference: `apps/{appId}/runs/{runId}` */
	run: (appId: string, runId: string): DocumentReference<RunSummaryDoc> =>
		collections.runs(appId).doc(runId),

	/** Direct reference: `apps/{appId}/threads/{threadId}` */
	thread: (appId: string, threadId: string): DocumentReference<ThreadDoc> =>
		collections.threads(appId).doc(threadId),

	/** Direct reference: `user_settings/{userId}` */
	settings: (userId: string): DocumentReference<UserSettingsDoc> =>
		collections.settings().doc(userId),

	/** Direct reference: `mediaAssets/{assetId}` */
	mediaAsset: (assetId: string): DocumentReference<MediaAssetDoc> =>
		collections.mediaAssets().doc(assetId),
};
