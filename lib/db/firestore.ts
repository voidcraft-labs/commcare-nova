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
	type WithFieldValue,
} from "@google-cloud/firestore";
import type { ZodType } from "zod";
import { type Event, eventSchema } from "@/lib/log/types";
import { firestoreClientOptions } from "./firestoreClientOptions";
import {
	type AcceptedMutationDoc,
	type AppDoc,
	acceptedMutationSchema,
	appDocSchema,
	type BatchDedupDoc,
	batchDedupSchema,
	type CreditGrantDoc,
	type CreditMonthDoc,
	creditGrantDocSchema,
	creditMonthDocSchema,
	type MediaAssetDoc,
	mediaAssetDocSchema,
	type PresenceDoc,
	presenceDocSchema,
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
const batchDedupConverter = zodConverter(batchDedupSchema);

/**
 * Exported so the relay route (`getListenDb()`-bound `onSnapshot`) can apply
 * the same Zod converter the `getDb()`-bound collection helpers do — the
 * listen client is constructed separately, so it needs the standalone
 * converter rather than only the bound collection helper.
 */
export const acceptedMutationConverter = zodConverter(acceptedMutationSchema);
/** Exported for the same listen-client reason as `acceptedMutationConverter`. */
export const presenceConverter = zodConverter(presenceDocSchema);

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

	/**
	 * Per-app durable mutation stream: `apps/{appId}/acceptedMutations/{seq}`.
	 *
	 * Takes an EXPLICIT client so the relay route can build its listen query on
	 * the gRPC `getListenDb()` (whose `preferRest: false` is what makes
	 * `onSnapshot` fire) rather than the REST-preferring `getDb()`, on which a
	 * listen silently never fires in prod. Defaults to `getDb()` for ordinary
	 * read/write callers.
	 */
	acceptedMutations: (
		appId: string,
		db: Firestore = getDb(),
	): CollectionReference<AcceptedMutationDoc> =>
		db
			.collection("apps")
			.doc(appId)
			.collection("acceptedMutations")
			.withConverter(acceptedMutationConverter),

	/**
	 * Per-app live presence roster: `apps/{appId}/presence/{userId}:{sessionId}`.
	 * Explicit client param for the same listen-vs-REST reason as
	 * `acceptedMutations`.
	 */
	presence: (
		appId: string,
		db: Firestore = getDb(),
	): CollectionReference<PresenceDoc> =>
		db
			.collection("apps")
			.doc(appId)
			.collection("presence")
			.withConverter(presenceConverter),

	/** Per-app batch idempotency latches: `apps/{appId}/batchDedup/{batchId}`. */
	batchDedup: (appId: string): CollectionReference<BatchDedupDoc> =>
		getDb()
			.collection("apps")
			.doc(appId)
			.collection("batchDedup")
			.withConverter(batchDedupConverter),
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

	/**
	 * Direct reference: `apps/{appId}/acceptedMutations/{seq}`. The doc id is
	 * the zero-padded `seq` (`String(seq).padStart(12, '0')`) so lexicographic
	 * doc-id ordering matches numeric `seq` ordering — a range scan / prune by
	 * doc id is the same as by `seq`.
	 */
	acceptedMutation: (
		appId: string,
		seq: number,
	): DocumentReference<AcceptedMutationDoc> =>
		collections.acceptedMutations(appId).doc(String(seq).padStart(12, "0")),

	/**
	 * Direct reference: `apps/{appId}/presence/{presenceId}` where
	 * `presenceId = `${userId}:${sessionId}`` (minted by the caller).
	 */
	presence: (
		appId: string,
		presenceId: string,
	): DocumentReference<PresenceDoc> =>
		collections.presence(appId).doc(presenceId),

	/** Direct reference: `apps/{appId}/batchDedup/{batchId}` (converter-applied, for the in-txn `set`). */
	batchDedup: (
		appId: string,
		batchId: string,
	): DocumentReference<BatchDedupDoc> =>
		collections.batchDedup(appId).doc(batchId),

	/**
	 * RAW (converter-less) reference to a batch-dedup doc, for the in-transaction
	 * dedup READ. A `withConverter` `tx.get()` routes the snapshot through
	 * `batchDedupSchema.parse`, which throws inside the transaction on a partial
	 * doc — same parse-on-read hazard the credit-reservation `creditMonthRaw`
	 * guards against. The dedup read reads raw and branches on `snap.exists`.
	 * `withConverter(null)` strips the converter from the same path
	 * `collections.batchDedup` owns, so the path stays single-sourced.
	 */
	batchDedupRaw: (appId: string, batchId: string): DocumentReference =>
		collections.batchDedup(appId).doc(batchId).withConverter(null),
};
