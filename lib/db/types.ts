/**
 * Firestore document schemas and derived types.
 *
 * Zod schemas are the single source of truth — TypeScript types are derived
 * via z.infer, and Firestore converters use schema.parse() for validated reads.
 *
 * Subcollection hierarchy (keyed by @dimagi.com email for human-readable paths):
 *
 *   users/{email}                                    → UserDoc
 *   users/{email}/usage/{yyyy-mm}                    → UsageDoc
 *   users/{email}/projects/{projectId}               → ProjectDoc
 *   users/{email}/projects/{projectId}/logs/{logId}  → LogEntryDoc (Phase 4)
 *
 * Projects are the fast path — one document read loads the full current state.
 * Logs are the audit/replay path — append-only, fetched only when needed.
 * Usage is the spend-cap path — one document per user per month for direct lookups.
 */
import { z } from 'zod'
import { Timestamp } from '@google-cloud/firestore'
import { appBlueprintSchema } from '../schemas/blueprint'

// ── Shared ──────────────────────────────────────────────────────────

/**
 * Firestore Timestamp validator. On reads, Firestore always returns Timestamp
 * instances — this validates that invariant rather than blindly casting.
 */
const timestamp = z.instanceof(Timestamp)

// ── User ────────────────────────────────────────────────────────────

/**
 * User profile — stored at `users/{email}`.
 *
 * Mirrors identity from Google OAuth. The document ID is the user's email
 * (e.g. "alice@dimagi.com") — stable, unique within the org, and readable
 * in the Firebase console. Better Auth handles session management statelessly;
 * this document exists for Firestore references and future admin features.
 */
export const userDocSchema = z.object({
  /** Display name from Google OAuth (e.g. "Alice Smith"). */
  name: z.string(),
  /** Google profile avatar URL. Null when no avatar is set. */
  image: z.string().nullable(),
  /** User role — controls access to admin dashboard (Phase 6). */
  role: z.enum(['user', 'admin']).default('user'),
  /** First sign-in timestamp. Set once via FieldValue.serverTimestamp(). */
  created_at: timestamp,
  /** Updated on each authenticated request via FieldValue.serverTimestamp(). */
  last_active_at: timestamp,
})
export type UserDoc = z.infer<typeof userDocSchema>

// ── Usage ───────────────────────────────────────────────────────────

/**
 * Monthly usage aggregation — stored at `users/{email}/usage/{yyyy-mm}`.
 *
 * One document per user per calendar month. The document ID is the period
 * string (e.g. "2026-04") so spend-cap checks are a single document read,
 * not a query. Fields are atomically incremented via FieldValue.increment()
 * after each run completes (Phase 5).
 */
export const usageDocSchema = z.object({
  /** Total input tokens consumed across all runs this period. */
  input_tokens: z.number().default(0),
  /** Total output tokens produced across all runs this period. */
  output_tokens: z.number().default(0),
  /** Estimated cost in USD, summed across all runs. */
  cost_estimate: z.number().default(0),
  /** Number of chat requests (generation runs) this period. */
  request_count: z.number().default(0),
  /** Last time this document was updated via FieldValue.serverTimestamp(). */
  updated_at: timestamp,
})
export type UsageDoc = z.infer<typeof usageDocSchema>

// ── Project ─────────────────────────────────────────────────────────

/**
 * Project document — stored at `users/{email}/projects/{projectId}`.
 *
 * Contains the full current blueprint state as a Firestore map (not a JSON
 * string). Loading a project is a single document read — hydrate the blueprint
 * and the builder is ready. No replay needed for the common "return to my work" flow.
 *
 * Denormalized fields (app_name, connect_type, module_count, form_count) enable
 * the project list page to render without deserializing every blueprint.
 */
export const projectDocSchema = z.object({
  /** App name — denormalized from blueprint for list display. */
  app_name: z.string(),
  /** The full blueprint, stored as a nested Firestore map. */
  blueprint: appBlueprintSchema,
  /** Connect app type — denormalized for list filtering. Null for standard apps. */
  connect_type: z.enum(['learn', 'deliver']).nullable().default(null),
  /** Number of modules — denormalized for list display. */
  module_count: z.number().default(0),
  /** Number of forms across all modules — denormalized for list display. */
  form_count: z.number().default(0),
  /** Build lifecycle status. */
  status: z.enum(['generating', 'complete', 'error']).default('complete'),
  /** Run ID of the generation/edit that last modified this project. */
  run_id: z.string().nullable().default(null),
  /** First save timestamp. Set once via FieldValue.serverTimestamp(). */
  created_at: timestamp,
  /** Updated on every save via FieldValue.serverTimestamp(). */
  updated_at: timestamp,
})
export type ProjectDoc = z.infer<typeof projectDocSchema>
