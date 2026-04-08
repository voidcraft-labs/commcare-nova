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
 *   collections.users()          → users/{userId}
 *   collections.usage(userId)    → users/{userId}/usage/{yyyy-mm}
 *   collections.apps()           → apps/{appId}          (root-level)
 *   collections.logs(appId)      → apps/{appId}/logs/{logId}
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
import {
	type AppDoc,
	appDocSchema,
	type StoredEvent,
	storedEventSchema,
	type UsageDoc,
	type UserDoc,
	usageDocSchema,
	userDocSchema,
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
			ignoreUndefinedProperties: true,
			/* Use REST instead of gRPC. Two reasons:
			 *
			 * 1. Build safety — gRPC channel establishment hangs indefinitely when
			 *    credentials aren't available (e.g. Docker build with no ADC/metadata
			 *    server). REST fails fast with an HTTP error, which the caller's
			 *    try/catch can handle gracefully.
			 *
			 * 2. Serverless fit — Cloud Run scales to zero. gRPC keeps a persistent
			 *    channel that must be re-established after cold starts and competes
			 *    with connection pooling across instances. REST is stateless and
			 *    avoids these issues. Recommended by Google for serverless. */
			preferRest: true,
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

const userConverter = zodConverter(userDocSchema);
const usageConverter = zodConverter(usageDocSchema);
const appConverter = zodConverter(appDocSchema);
const storedEventConverter = zodConverter(storedEventSchema);

// ── Collection Helpers ─────────────────────────────────────────────

/**
 * Typed collection references for each document type.
 *
 * Returns a CollectionReference with the Zod converter applied, so reads
 * are validated and writes accept `WithFieldValue<T>` (allows `FieldValue`
 * sentinels like `serverTimestamp()` in place of their resolved types).
 *
 * Apps are a root-level collection — no parent ID needed.
 * Logs are subcollections of their app document.
 * Usage is a subcollection of the user document.
 *
 * Usage:
 *   const apps = await collections.apps().where('owner', '==', userId).get()
 *   apps.docs.forEach(doc => doc.data())  // → AppDoc (validated)
 */
export const collections = {
	/** Top-level users collection: `users/{userId}` */
	users: (): CollectionReference<UserDoc> =>
		getDb().collection("users").withConverter(userConverter),

	/** Per-user monthly usage: `users/{userId}/usage/{yyyy-mm}` */
	usage: (userId: string): CollectionReference<UsageDoc> =>
		getDb()
			.collection("users")
			.doc(userId)
			.collection("usage")
			.withConverter(usageConverter),

	/** Root-level apps collection: `apps/{appId}` */
	apps: (): CollectionReference<AppDoc> =>
		getDb().collection("apps").withConverter(appConverter),

	/** Per-app log events: `apps/{appId}/logs/{logId}` */
	logs: (appId: string): CollectionReference<StoredEvent> =>
		getDb()
			.collection("apps")
			.doc(appId)
			.collection("logs")
			.withConverter(storedEventConverter),
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
	/** Direct reference: `users/{userId}` */
	user: (userId: string): DocumentReference<UserDoc> =>
		collections.users().doc(userId),

	/** Direct reference: `users/{userId}/usage/{yyyy-mm}` */
	usage: (userId: string, period: string): DocumentReference<UsageDoc> =>
		collections.usage(userId).doc(period),

	/** Direct reference: `apps/{appId}` */
	app: (appId: string): DocumentReference<AppDoc> =>
		collections.apps().doc(appId),

	/** Direct reference: `apps/{appId}/logs/{logId}` */
	logEntry: (appId: string, logId: string): DocumentReference<StoredEvent> =>
		collections.logs(appId).doc(logId),
};
