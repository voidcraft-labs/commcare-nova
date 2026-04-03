/**
 * Project CRUD helpers — thin wrappers over Firestore collection/document helpers.
 *
 * Provides typed, validated read/write operations for project documents.
 * All writes extract denormalized fields from the blueprint automatically
 * so list queries never need to deserialize full blueprints.
 */
import { FieldValue, Timestamp } from '@google-cloud/firestore'
import type { AppBlueprint } from '../schemas/blueprint'
import type { ErrorType } from '../services/errorClassifier'
import type { ProjectDoc } from './types'
import { getDb, collections, docs } from './firestore'
import { log } from '@/lib/log'

// ── Types ──────────────────────────────────────────────────────────

/** Subset of ProjectDoc fields returned by list queries (no full blueprint). */
export interface ProjectSummary {
  id: string
  app_name: string
  connect_type: ProjectDoc['connect_type']
  module_count: number
  form_count: number
  status: ProjectDoc['status']
  /** Error classification string — present only when status is 'error'. */
  error_type: string | null
  /** ISO 8601 string — Firestore Timestamp converted at the query boundary. */
  created_at: string
  /** ISO 8601 string — Firestore Timestamp converted at the query boundary. */
  updated_at: string
}

/**
 * Maximum age (in minutes) before a 'generating' project is considered dead.
 *
 * Well above the 5-minute `maxDuration` route timeout — any project still
 * 'generating' after this threshold was killed by the platform or crashed
 * without writing a failure status.
 */
const MAX_GENERATION_MINUTES = 10

// ── Helpers ────────────────────────────────────────────────────────

/** Extract denormalized fields from a blueprint for list display. */
function denormalize(blueprint: AppBlueprint) {
  const modules = blueprint.modules ?? []
  return {
    app_name: blueprint.app_name || 'Untitled',
    connect_type: blueprint.connect_type ?? null,
    module_count: modules.length,
    form_count: modules.reduce((sum, m) => sum + (m.forms?.length ?? 0), 0),
  }
}

// ── CRUD ───────────────────────────────────────────────────────────

/**
 * Create a new project document at the start of generation.
 *
 * Called by the route handler when a new build starts (no projectId from client).
 * The document starts with `status: 'generating'` and an empty blueprint —
 * `completeProject` fills in the final blueprint when generation succeeds.
 * Returns the generated projectId for immediate use (logging, URL update).
 */
export async function createProject(
  email: string,
  runId: string,
): Promise<string> {
  const ref = collections.projects(email).doc()
  const emptyBlueprint: AppBlueprint = { app_name: '', modules: [], case_types: null }
  await ref.set({
    ...denormalize(emptyBlueprint),
    blueprint: emptyBlueprint,
    status: 'generating',
    error_type: null,
    run_id: runId,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  })
  return ref.id
}

/**
 * Update a project with the final validated blueprint on generation success.
 *
 * Called by validateApp after the build pipeline completes. Updates the
 * blueprint, denormalized fields, status, and run_id — preserves created_at.
 */
export async function completeProject(
  email: string,
  projectId: string,
  blueprint: AppBlueprint,
  runId: string,
): Promise<void> {
  await docs.project(email, projectId).set({
    ...denormalize(blueprint),
    blueprint,
    status: 'complete',
    run_id: runId,
    updated_at: FieldValue.serverTimestamp(),
  }, { merge: true })
}

/**
 * Mark a project as failed after an error during generation.
 *
 * Fire-and-forget — a Firestore outage must never block the error response.
 * The timeout inference in `listProjects()` serves as a backstop if this
 * write fails or the process dies before reaching this code.
 */
export function failProject(
  email: string,
  projectId: string,
  errorType: ErrorType,
): void {
  docs.project(email, projectId).set({
    status: 'error',
    error_type: errorType,
  }, { merge: true })
    .catch(err => log.error('[failProject] Firestore write failed', err))
}

/**
 * Merge-update an existing project with a new blueprint snapshot.
 *
 * Used by the auto-save hook after client-side edits. Uses `set` with
 * `merge: true` instead of `update` for consistency with other write paths.
 *
 * Only touches the blueprint, denormalized fields, and updated_at —
 * preserves created_at, run_id, and status from the original save.
 */
export async function updateProject(
  email: string,
  projectId: string,
  blueprint: AppBlueprint,
): Promise<void> {
  await docs.project(email, projectId).set({
    ...denormalize(blueprint),
    blueprint,
    updated_at: FieldValue.serverTimestamp(),
  }, { merge: true })
}

/**
 * Load a single project document by ID.
 *
 * Returns the full ProjectDoc (including blueprint) or null if not found.
 * The Zod converter validates the document on read.
 */
export async function loadProject(
  email: string,
  projectId: string,
): Promise<ProjectDoc | null> {
  const snap = await docs.project(email, projectId).get()
  return snap.exists ? snap.data()! : null
}

/** The denormalized fields fetched by `listProjects` — no blueprint. */
const SUMMARY_FIELDS = [
  'app_name', 'connect_type', 'module_count', 'form_count',
  'status', 'error_type', 'created_at', 'updated_at',
] as const

/**
 * List a user's projects sorted by last modified, without full blueprints.
 *
 * Uses Firestore `select()` to fetch only the denormalized summary fields —
 * the blueprint (the large nested object) is never read. Validation is
 * unnecessary here because data is validated on write (completeProject,
 * updateProject) and defaults are baked in at that time.
 */
export async function listProjects(
  email: string,
  limit = 50,
): Promise<ProjectSummary[]> {
  const snap = await getDb()
    .collection('users').doc(email).collection('projects')
    .select(...SUMMARY_FIELDS)
    .orderBy('updated_at', 'desc')
    .limit(limit)
    .get()

  const now = Date.now()
  const maxAgeMs = MAX_GENERATION_MINUTES * 60_000

  return snap.docs.map(doc => {
    const data = doc.data()
    const createdAt = (data.created_at as Timestamp).toDate()

    /*
     * Timeout inference — if a project has been 'generating' longer than
     * the platform timeout allows, it's dead. Infer failure on the read
     * path and persist the correction so it's only inferred once.
     */
    const isStale = data.status === 'generating' && (now - createdAt.getTime()) > maxAgeMs
    if (isStale) {
      failProject(email, doc.id, 'internal')
    }

    return {
      id: doc.id,
      app_name: data.app_name as string,
      connect_type: (data.connect_type as ProjectDoc['connect_type']) ?? null,
      module_count: (data.module_count as number) ?? 0,
      form_count: (data.form_count as number) ?? 0,
      status: isStale ? 'error' : (data.status as ProjectDoc['status']),
      error_type: isStale ? 'internal' : ((data.error_type as string | null) ?? null),
      created_at: createdAt.toISOString(),
      updated_at: (data.updated_at as Timestamp).toDate().toISOString(),
    }
  })
}

