/**
 * Project CRUD helpers — thin wrappers over Firestore collection/document helpers.
 *
 * Provides typed, validated read/write operations for project documents.
 * All writes extract denormalized fields from the blueprint automatically
 * so list queries never need to deserialize full blueprints.
 */
import { FieldValue } from '@google-cloud/firestore'
import type { AppBlueprint } from '../schemas/blueprint'
import type { ProjectDoc } from './types'
import { collections, docs } from './firestore'

// ── Types ──────────────────────────────────────────────────────────

/** Subset of ProjectDoc fields returned by list queries (no full blueprint). */
export interface ProjectSummary {
  id: string
  app_name: string
  connect_type: ProjectDoc['connect_type']
  module_count: number
  form_count: number
  status: ProjectDoc['status']
  created_at: Date
  updated_at: Date
}

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

/**
 * List a user's projects sorted by last modified, without full blueprints.
 *
 * Returns denormalized summaries for the project list page. Reads full
 * documents through the Zod converter (validated reads), then extracts
 * only the summary fields — Firestore's `select()` would skip the
 * converter, bypassing validation.
 */
export async function listProjects(
  email: string,
  limit = 50,
): Promise<ProjectSummary[]> {
  const snap = await collections.projects(email)
    .orderBy('updated_at', 'desc')
    .limit(limit)
    .get()

  return snap.docs.map(doc => {
    const data = doc.data()
    return {
      id: doc.id,
      app_name: data.app_name,
      connect_type: data.connect_type,
      module_count: data.module_count,
      form_count: data.form_count,
      status: data.status,
      created_at: data.created_at.toDate(),
      updated_at: data.updated_at.toDate(),
    }
  })
}

