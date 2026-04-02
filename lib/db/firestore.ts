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
 * accept them (with FieldValue support via WithFieldValue<T>). Subcollection
 * helpers take parent IDs to navigate the hierarchy:
 *
 *   collections.users()                    → users/{email}
 *   collections.usage(email)               → users/{email}/usage/{yyyy-mm}
 *   collections.projects(email)            → users/{email}/projects/{projectId}
 *   collections.logs(email, projectId)     → users/{email}/projects/{projectId}/logs/{logId}
 */
import {
  Firestore,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
  type WithFieldValue,
} from '@google-cloud/firestore'
import type { ZodType } from 'zod'
import {
  userDocSchema, type UserDoc,
  usageDocSchema, type UsageDoc,
  projectDocSchema, type ProjectDoc,
  storedEventSchema, type StoredEvent,
} from './types'

// ── Singleton ──────────────────────────────────────────────────────

let _db: Firestore | null = null

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
    })
  }
  return _db
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
    fromFirestore: (snapshot: QueryDocumentSnapshot) => schema.parse(snapshot.data()),
  } as FirestoreDataConverter<T>
}

const userConverter = zodConverter(userDocSchema)
const usageConverter = zodConverter(usageDocSchema)
const projectConverter = zodConverter(projectDocSchema)
const storedEventConverter = zodConverter(storedEventSchema)

// ── Collection Helpers ─────────────────────────────────────────────

/**
 * Typed collection references for each document type.
 *
 * Subcollection helpers require parent document IDs to build the path.
 * Returns a CollectionReference with the Zod converter applied, so reads
 * are validated and writes accept `WithFieldValue<T>` (allows `FieldValue`
 * sentinels like `serverTimestamp()` in place of their resolved types).
 *
 * Usage:
 *   const projects = await collections.projects('alice@dimagi.com').get()
 *   projects.docs.forEach(doc => doc.data())  // → ProjectDoc (validated)
 */
export const collections = {
  /** Top-level users collection: `users/{email}` */
  users: (): CollectionReference<UserDoc> =>
    getDb().collection('users').withConverter(userConverter),

  /** Per-user monthly usage: `users/{email}/usage/{yyyy-mm}` */
  usage: (email: string): CollectionReference<UsageDoc> =>
    getDb().collection('users').doc(email)
      .collection('usage').withConverter(usageConverter),

  /** Per-user projects: `users/{email}/projects/{projectId}` */
  projects: (email: string): CollectionReference<ProjectDoc> =>
    getDb().collection('users').doc(email)
      .collection('projects').withConverter(projectConverter),

  /** Per-project log events: `users/{email}/projects/{projectId}/logs/{logId}` */
  logs: (email: string, projectId: string): CollectionReference<StoredEvent> =>
    getDb().collection('users').doc(email)
      .collection('projects').doc(projectId)
      .collection('logs').withConverter(storedEventConverter),
}

// ── Document Helpers ───────────────────────────────────────────────

/**
 * Typed document references for direct lookups by ID.
 *
 * Useful when you know the exact document path and want a single read
 * or write without querying the collection.
 *
 * Usage:
 *   const snap = await docs.project('alice@dimagi.com', 'abc123').get()
 *   if (snap.exists) console.log(snap.data()!.app_name)  // → string (validated)
 */
export const docs = {
  /** Direct reference: `users/{email}` */
  user: (email: string): DocumentReference<UserDoc> =>
    collections.users().doc(email),

  /** Direct reference: `users/{email}/usage/{yyyy-mm}` */
  usage: (email: string, period: string): DocumentReference<UsageDoc> =>
    collections.usage(email).doc(period),

  /** Direct reference: `users/{email}/projects/{projectId}` */
  project: (email: string, projectId: string): DocumentReference<ProjectDoc> =>
    collections.projects(email).doc(projectId),

  /** Direct reference: `users/{email}/projects/{projectId}/logs/{logId}` */
  logEntry: (email: string, projectId: string, logId: string): DocumentReference<StoredEvent> =>
    collections.logs(email, projectId).doc(logId),
}
